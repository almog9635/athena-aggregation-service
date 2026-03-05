import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { SessionRegistryService } from './session-registry.service';
import { DiffEntityResult } from './types/diff';
import { EmptyDiffService } from './providers/empty-diff.service';
import { Session } from './types/session';
import { EventsQueryDto } from './dto/events-query.dto';

type SseResponse = Response & { flushHeaders?: () => void };

interface DiffPayload {
  entityName: string;
  version: number;
  data: unknown;
}

@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly maxPayloadBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly chunkSizeBytes: number;
  private readonly defaultRangeDays: number;
  private readonly maxSessions: number;
  private readonly sessionTTLms: number;
  private readonly maxRangeDays: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SessionRegistryService,
    private readonly diffService: EmptyDiffService,
  ) {
    this.maxPayloadBytes =
      this.config.get<number>('SSE_MAX_PAYLOAD_MB', 10) * 1024 * 1024;
    this.heartbeatIntervalMs = this.config.get<number>(
      'SSE_HEARTBEAT_INTERVAL_MS',
      15_000,
    );
    this.chunkSizeBytes =
      this.config.get<number>('SSE_CHUNK_SIZE_KB', 512) * 1024;
    this.defaultRangeDays = this.config.get<number>(
      'SSE_DEFAULT_RANGE_DAYS',
      7,
    );
    this.maxRangeDays = this.config.get<number>(
      'SSE_MAX_RANGE_DAYS',
      120, // 4 months default
    );
    this.maxSessions = this.config.get<number>(
      'SSE_MAX_SESSIONS_PER_INSTANCE',
      2_000,
    );

    // TTL for sessions; 12hours by default, overridable via config.
    this.sessionTTLms =
      this.config.get<number>('SSE_SESSION_TTL_HOURS', 12) * 60 * 60 * 1000;
    // prune once an hour
    this.cleanupTimer = setInterval(
      () => this.pruneOldSessions(),
      60 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /**
   * Public entrypoint for initial client connection.
   */
  async handleConnection(
    res: Response,
    userId: string,
    params: EventsQueryDto,
  ): Promise<void> {
    if (this.registry.countSessions() >= this.maxSessions) {
      await this.sendErrorAndClose(
        res,
        `limit_exceeded: max ${this.maxSessions} sessions reached`,
      );
      this.logger.error('Max SSE sessions per instance exceeded');
      return;
    }

    if (!params.squadronIds || params.squadronIds.length === 0) {
      await this.sendErrorAndClose(res, 'invalid_squadron_ids');
      return;
    }

    // Check if both dates are provided or both are missing
    const bothProvided = params.startDate && params.endDate;
    const neitherProvided = !params.startDate && !params.endDate;

    if (!bothProvided && !neitherProvided) {
      await this.sendErrorAndClose(
        res,
        'invalid_date_params: both start and end dates required or neither',
      );
      return;
    }

    const now = Date.now();
    let start: string;
    let end: string;

    if (neitherProvided) {
      // Use defaults
      const defaultStart = new Date(
        now - this.defaultRangeDays * 86_400_000,
      ).toISOString();
      const defaultEnd = new Date(now).toISOString();
      start = defaultStart;
      end = defaultEnd;
    } else {
      // Both provided, validate dates
      if (isNaN(Date.parse(params.startDate!))) {
        await this.sendErrorAndClose(res, 'invalid_start_date');
        return;
      }
      if (isNaN(Date.parse(params.endDate!))) {
        await this.sendErrorAndClose(res, 'invalid_end_date');
        return;
      }
      if (new Date(params.startDate!) > new Date(params.endDate!)) {
        await this.sendErrorAndClose(res, 'invalid_date_range');
        return;
      }
      start = params.startDate!;
      end = params.endDate!;
    }

    // Validate range does not exceed max allowed days
    const rangeMs = new Date(end).getTime() - new Date(start).getTime();
    const rangeDays = rangeMs / 86_400_000;
    if (rangeDays > this.maxRangeDays) {
      await this.sendErrorAndClose(
        res,
        `range_exceeds_limit: maximum ${this.maxRangeDays} days allowed`,
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const sessionId: string = uuidv4();

    const session: Session = {
      sessionId,
      userId,
      squadronIds: params.squadronIds,
      startDate: start,
      endDate: end,
      dataGroup: params.dataGroup,
      response: res,
      createdAt: Date.now(),
    };

    this.setupResponse(res as SseResponse);
    this.registry.add(session);
    this.startHeartbeat(session);

    res.on('close', () => this.cleanupSession(session));

    // inform client about its session id immediately
    await this.sendEvent(
      res,
      'session',
      JSON.stringify({ sessionId: session.sessionId }),
    );

    // initial sync
    const diff = this.diffService.getDiff(
      session.squadronIds,
      session.startDate,
      session.endDate,
      undefined,
      session.dataGroup,
    );

    await this.streamDiff(session, diff);
  }


  /**
   * Broadcast an update when a given entity has a new version.
   * Iterates all sessions and pushes diffs for those who need them.
   */
  async broadcastEntityUpdate(diff: DiffEntityResult[]): Promise<void> {
    const sessions = [...this.registry.allSessions()];
    await Promise.all(
      sessions.map((session) =>
        this.streamDiff(session, diff).catch((err) =>
          this.logger.error(
            `failed to stream diff to session ${session.sessionId}`,
            err,
          ),
        ),
      ),
    );
  }

  /**
   * Write SSE headers and ensure flush
   */
  private setupResponse(res: SseResponse): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }

  private startHeartbeat(session: Session) {
    const tick = async () => {
      if (!session.response) return;

      try {
        await this.sendEvent(session.response, 'heartbeat', `${Date.now()}`);
      } catch (err) {
        this.logger.warn('heartbeat write failed', err);
        return;
      }

      session.heartbeatTimer = setTimeout(() => {
        void tick(); // explicitly ignore the Promise
      }, this.heartbeatIntervalMs);
    };

    session.heartbeatTimer = setTimeout(() => {
      void tick(); // explicitly ignore the Promise
    }, this.heartbeatIntervalMs);
  }

  private cleanupSession(session: Session): void {
    if (session.heartbeatTimer) {
      clearTimeout(
        session.heartbeatTimer as unknown as ReturnType<typeof setTimeout>,
      );
      session.heartbeatTimer = null;
    }

    this.registry.remove(session);
    session.response = null;
    this.logger.log(`session ${session.sessionId} removed`);
  }

  /** remove sessions that have lived longer than TTL */
  private pruneOldSessions(): void {
    const now = Date.now();
    for (const session of this.registry.allSessions()) {
      if (now - session.createdAt > this.sessionTTLms) {
        this.logger.log(`session ${session.sessionId} expired by TTL`);
        this.cleanupSession(session);
      }
    }
  }

  private async streamDiff(
    session: Session,
    diff: DiffEntityResult[],
  ): Promise<void> {
    if (!session.response) {
      this.logger.warn(`session ${session.sessionId} has no open response`);
      return;
    }

    for (const entity of diff) {
      const payload: DiffPayload = {
        entityName: entity.entityName,
        version: entity.version,
        data: entity.data,
      };

      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > this.maxPayloadBytes) {
        this.sendChunked(session, payload);
      } else {
        await this.sendBulk(session, payload);
      }
    }
  }

  private async sendBulk(
    session: Session,
    payload: DiffPayload,
    json?: string,
  ): Promise<void> {
    if (!session.response) return;

    const data = json ?? JSON.stringify(payload);
    try {
      await this.sendEvent(session.response, 'diff', data);
    } catch (err) {
      this.logger.error(`unable to send bulk to ${session.sessionId}`, err);
    }
  }

  private async sendChunked(session: Session, payload: DiffPayload) {
    if (!session.response) return;

    const json = JSON.stringify(payload);
    const totalBytes = Buffer.byteLength(json);
    const totalChunks = Math.ceil(totalBytes / this.chunkSizeBytes);

    for (let idx = 0; idx < totalChunks; idx++) {
      const chunk = json.slice(
        idx * this.chunkSizeBytes,
        (idx + 1) * this.chunkSizeBytes,
      );
      await this.sendEvent(session.response, 'diff-chunk', chunk);
    }

    const donePayload = {
      entityName: payload.entityName,
      version: payload.version,
    };
    await this.sendEvent(
      session.response,
      'data-complete',
      JSON.stringify(donePayload),
    );
  }

  private async sendEvent(
    res: Response,
    event: string,
    data: string,
  ): Promise<void> {
    const outLines = [`event: ${event}`].concat(
      data.split(/\r?\n/).map((line) => `data: ${line}`),
    );
    const out = outLines.join('\n') + '\n\n';

    const ok = res.write(out);
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onClose = () => {
          res.off('drain', onDrain);
          reject(new Error('stream closed'));
        };
        const onDrain = () => {
          res.off('close', onClose);
          resolve();
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
      });
    }
  }

  private async sendErrorAndClose(
    res: Response,
    message: string,
  ): Promise<void> {
    await this.sendEvent(res, 'error', message);
    await new Promise<void>((resolve) => res.end(() => resolve()));
  }
}
