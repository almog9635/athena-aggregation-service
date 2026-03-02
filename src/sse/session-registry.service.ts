import { Injectable, Logger } from '@nestjs/common';
import { Session } from './types/session';

@Injectable()
export class SessionRegistryService {
  private readonly logger = new Logger(SessionRegistryService.name);
  // structure: squadronId -> sessionId -> Session
  private readonly registry = new Map<string, Map<string, Session>>();

  add(session: Session): void {
    session.squadronIds.forEach((squadronId) => {
      let squadMap = this.registry.get(squadronId);
      if (!squadMap) {
        squadMap = new Map();
        this.registry.set(squadronId, squadMap);
      }
      squadMap.set(session.sessionId, session);
    });
  }

  remove(session: Session): void {
    session.squadronIds.forEach((squadronId) => {
      const squadMap = this.registry.get(squadronId);
      if (!squadMap) return;

      squadMap.delete(session.sessionId);
      if (squadMap.size === 0) {
        this.registry.delete(squadronId);
      }
    });
  }

  findById(sessionId: string): Session | undefined {
    for (const squadMap of this.registry.values()) {
      if (squadMap.has(sessionId)) {
        return squadMap.get(sessionId);
      }
    }
    return undefined;
  }

  /** count distinct sessions (a single session may appear under multiple squadrons) */
  countSessions(): number {
    const seen = new Set<string>();
    for (const map of this.registry.values()) {
      for (const session of map.values()) {
        seen.add(session.sessionId);
      }
    }
    return seen.size;
  }

  *allSessions(): IterableIterator<Session> {
    const seen = new Set<string>();
    for (const map of this.registry.values()) {
      for (const session of map.values()) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        yield session;
      }
    }
  }

  *sessionsForSquadron(squadronId: string): IterableIterator<Session> {
    const squadMap = this.registry.get(squadronId);
    if (!squadMap) return;
    for (const session of squadMap.values()) {
      yield session;
    }
  }
}
