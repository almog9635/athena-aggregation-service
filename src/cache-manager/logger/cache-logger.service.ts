import { Injectable, Logger } from '@nestjs/common';

export interface ICacheLogger {
    logHit(name: string, days?: string[]): void;
    logMiss(name: string, days?: string[]): void;
    logEviction(name: string, days?: string[]): void;
    logTtlStart(name: string, ttlMs: number, days?: string[]): void;
    logTtlCancel(name: string, days?: string[]): void;
    logAggregationStart(name: string, days?: string[]): void;
    logAggregationComplete(name: string, timeTakenMs: number, days?: string[]): void;
    logPollingUpdate(name: string, newVersion: number, days?: string[]): void;
    logRelationDisposal(name: string, id: string): void;
    logError(message: string, error: any): void;
}

@Injectable()
export class DefaultCacheLogger implements ICacheLogger {
    private readonly logger = new Logger('CacheManager');

    private formatId(name: string, days?: string[]): string {
        return days && days.length > 0 ? `${name} [Days: ${days.join(',')}]` : name;
    }

    logHit(name: string, days?: string[]): void {
        this.logger.debug(`[HIT] ${this.formatId(name, days)}`);
    }

    logMiss(name: string, days?: string[]): void {
        this.logger.debug(`[MISS] ${this.formatId(name, days)}`);
    }

    logEviction(name: string, days?: string[]): void {
        this.logger.log(`[EVICTED] ${this.formatId(name, days)} cleared from memory.`);
    }

    logTtlStart(name: string, ttlMs: number, days?: string[]): void {
        this.logger.debug(`[TTL START] ${this.formatId(name, days)} refCount is 0. Evicting in ${ttlMs}ms.`);
    }

    logTtlCancel(name: string, days?: string[]): void {
        this.logger.debug(`[TTL CANCELLED] ${this.formatId(name, days)} re-acquired.`);
    }

    logAggregationStart(name: string, days?: string[]): void {
        this.logger.debug(`[AGGREGATION START] Building ${this.formatId(name, days)} from sources...`);
    }

    logAggregationComplete(name: string, timeTakenMs: number, days?: string[]): void {
        this.logger.debug(`[AGGREGATION COMPLETE] ${this.formatId(name, days)} built in ${timeTakenMs}ms.`);
    }

    logPollingUpdate(name: string, newVersion: number, days?: string[]): void {
        this.logger.log(`[UPDATE] ${this.formatId(name, days)} polled new version: ${newVersion}. Modified fields merged.`);
    }

    logRelationDisposal(name: string, id: string): void {
        this.logger.log(`[RELATION DISPOSAL] Removing orphaned ${name}:${id} from active tracking.`);
    }

    logError(message: string, error: any): void {
        this.logger.error(`[ERROR] ${message}`, error instanceof Error ? error.stack : error);
    }
}
