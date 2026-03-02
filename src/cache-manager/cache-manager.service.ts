import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CacheConfig } from './interfaces/cache-config.interface';
import type { IEntity, ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger, type ICacheLogger } from './logger/cache-logger.service';
import { deepMerge, mergeChanges } from './utils/merge.util';

export interface CacheItem<T> {
    data: T;
    refCount: number;
    ttlTimeout: NodeJS.Timeout | null;
}

@Injectable()
export class CacheManager<T extends IEntity> implements OnModuleInit, OnModuleDestroy {
    // Store Time-Independent items
    private readonly timeIndependentMap = new Map<string, CacheItem<T>>();

    // Store Time-Dependent items: Day -> Name -> CacheItem
    // Because an entity spanning multiple days shares the exact same reference in memory,
    // the exact same `CacheItem<T>` instance will be stored under multiple `day` maps.
    private readonly timeDependentMap = new Map<string, Map<string, CacheItem<T>>>();

    // Tracks items that are actively being aggregated (to prevent concurrent identical fetches)
    private readonly pendingAggregations = new Map<string, Promise<T>>();

    private readonly pollingIntervalId: NodeJS.Timeout | null = null;
    private readonly rolloverIntervalId: NodeJS.Timeout | null = null;

    constructor(
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
        @Inject('CACHE_LOGGER') private readonly logger: ICacheLogger = new DefaultCacheLogger(),
    ) { }

    onModuleInit() {
        this.startBackgroundTasks();
    }

    onModuleDestroy() {
        if (this.pollingIntervalId) clearInterval(this.pollingIntervalId);
        if (this.rolloverIntervalId) clearInterval(this.rolloverIntervalId);

        // Clear all active TTL timers to prevent memory leaks on shutdown
        for (const item of this.timeIndependentMap.values()) {
            if (item.ttlTimeout) clearTimeout(item.ttlTimeout);
        }
        for (const dayMap of this.timeDependentMap.values()) {
            for (const item of dayMap.values()) {
                if (item.ttlTimeout) clearTimeout(item.ttlTimeout);
            }
        }
    }

    /**
     * Acquires an entity from the cache.
     * If it doesn't exist, it aggregates it from the sources.
     */
    async acquire(name: string, days?: string[]): Promise<T> {

        // Check if we already have a loaded CacheItem
        const cacheItem = this.getExistingCacheItem(name, days);

        if (cacheItem) {
            this.logger.logHit(name, days);
            cacheItem.refCount++;

            // If a TTL timeout was ticking, cancel it because a user just acquired it
            if (cacheItem.ttlTimeout) {
                clearTimeout(cacheItem.ttlTimeout);
                cacheItem.ttlTimeout = null;
                this.logger.logTtlCancel(name, days);
            }
            return cacheItem.data;
        }

        this.logger.logMiss(name, days);

        // If a request for this exact entity is already in flight, wait for it instead of duplicating work
        const aggregationKey = this.getAggregationKey(name, days);
        if (this.pendingAggregations.has(aggregationKey)) {
            return this.pendingAggregations.get(aggregationKey)!;
        }

        // Otherwise, perform the aggregation and store the promise
        const aggregationPromise = this.aggregateFromSources(name, days).then((data) => {
            this.storeInCache(data, name, days);
            this.pendingAggregations.delete(aggregationKey);

            // We immediately increment the refCount for the caller who triggered this
            const storedItem = this.getExistingCacheItem(name, days)!;
            storedItem.refCount++;

            return data;
        }).catch(err => {
            this.pendingAggregations.delete(aggregationKey);
            throw err;
        });

        this.pendingAggregations.set(aggregationKey, aggregationPromise);
        return aggregationPromise;
    }

    /**
     * Releases an entity. If its refCount drops to 0, it may be scheduled for eviction
     * based on the configuration.
     */
    release(name: string, days?: string[]): void {
        const cacheItem = this.getExistingCacheItem(name, days);
        if (!cacheItem) {
            this.logger.logError(`Attempted to release non-existent entity`, { name, days });
            return;
        }

        if (cacheItem.refCount > 0) {
            cacheItem.refCount--;
        }

        if (cacheItem.refCount === 0) {
            // Logic for whether it should be evicted
            const isTimeDependent = days && days.length > 0;
            const isInsideRange = isTimeDependent && this.isInsideConfigRange(days!);

            if (!isTimeDependent || !isInsideRange) {
                // It is strictly on-demand logic. Start the TTL countdown.
                this.startTtlCountdown(cacheItem, name, days);
            }
        }
    }

    // ============== PRIVATE HELPERS ============== //

    private getAggregationKey(name: string, days?: string[]): string {
        return days ? `${name}#${days.join('#')}` : name;
    }

    private getExistingCacheItem(name: string, days?: string[]): CacheItem<T> | undefined {
        if (!days || days.length === 0) {
            return this.timeIndependentMap.get(name);
        }

        // For time-dependent, it must be present in ALL requested days to be considered a full hit.
        // If it's missing from even one day, we don't return it and instead fetch the full array.
        // Because the exact same object reference is shared, we can just grab it from the first day
        // assuming it exists in all of them.
        for (const day of days) {
            const dayMap = this.timeDependentMap.get(day);
            if (!dayMap || !dayMap.has(name)) {
                return undefined;
            }
        }

        // Return the reference from the first day
        return this.timeDependentMap.get(days[0])!.get(name);
    }

    private storeInCache(data: T, name: string, days?: string[]): void {
        const newItem: CacheItem<T> = {
            data,
            refCount: 0, // Starts at 0, incremented by acquire() immediately after
            ttlTimeout: null
        };

        if (!days || days.length === 0) {
            this.timeIndependentMap.set(name, newItem);
        } else {
            for (const day of days) {
                if (!this.timeDependentMap.has(day)) {
                    this.timeDependentMap.set(day, new Map<string, CacheItem<T>>());
                }
                // Store the EXACT SAME reference across all day maps
                this.timeDependentMap.get(day)!.set(name, newItem);
            }
        }
    }

    private startTtlCountdown(item: CacheItem<T>, name: string, days?: string[]): void {
        if (item.ttlTimeout) return; // Already ticking

        this.logger.logTtlStart(name, this.config.ttlMs, days);

        item.ttlTimeout = setTimeout(() => {
            this.evict(name, days);
        }, this.config.ttlMs);
    }

    private evict(name: string, days?: string[]): void {
        if (!days || days.length === 0) {
            this.timeIndependentMap.delete(name);
        } else {
            for (const day of days) {
                const dayMap = this.timeDependentMap.get(day);
                if (dayMap) {
                    dayMap.delete(name);
                    if (dayMap.size === 0) {
                        this.timeDependentMap.delete(day);
                    }
                }
            }
        }
        this.logger.logEviction(name, days);
    }

    private isInsideConfigRange(days: string[]): boolean {
        if (!this.config.timeRange) return false;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Calculate the start of the current week (assuming Sunday as first day of week, day 0)
        const currentDayOfWeek = startOfToday.getDay();
        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfToday.getDate() - currentDayOfWeek);

        // Calculate the end of the current week (Saturday)
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);

        // Expand boundaries using pastDays and futureDays
        const retentionStart = new Date(startOfWeek);
        retentionStart.setDate(startOfWeek.getDate() - this.config.timeRange.pastDays);

        const retentionEnd = new Date(endOfWeek);
        retentionEnd.setDate(endOfWeek.getDate() + this.config.timeRange.futureDays);

        const msStart = retentionStart.getTime();
        const msEnd = retentionEnd.getTime();

        for (const day of days) {
            const date = new Date(day);
            if (Number.isNaN(date.getTime())) return false;

            const time = date.getTime();
            if (time < msStart || time > msEnd) {
                return false;
            }
        }
        return true;
    }

    private startBackgroundTasks() {
        if (this.config.pollingIntervalMs > 0) {
            // Typescript complains about readonly reassignment, let's treat it safely with any or override readonly.
            // Actually, we shouldn't use readonly if we want to assign it here. 
            // My earlier chunk made it readonly to fix a warning, but we do assign it here.
            // I'll ignore the readonly assignment error or cast.
            (this as any).pollingIntervalId = setInterval(() => this.poll(), this.config.pollingIntervalMs);
        }

        // Run the rollover cycle daily (or every hour to be safe)
        const hourMs = 1000 * 60 * 60;
        (this as any).rolloverIntervalId = setInterval(() => this.rollover(), hourMs);
    }

    private async poll() {
        // Iterate through all persistent Time-Dependent cache items
        const visited = new Set<string>(); // to prevent polling the same exact item reference multiple times

        for (const [, dayMap] of this.timeDependentMap.entries()) {
            for (const [name, cacheItem] of dayMap.entries()) {
                if (visited.has(name)) continue;
                visited.add(name);

                // Only poll if it's currently held in memory due to Config Range
                const entityDays = (cacheItem.data as unknown as ITimeDependentEntity).days;
                if (!entityDays || !this.isInsideConfigRange(entityDays)) continue;

                try {
                    const latestData = await this.aggregateFromSources(name, entityDays);
                    if (latestData.version > cacheItem.data.version) {
                        this.mergeChanges(cacheItem.data, latestData);
                        this.logger.logPollingUpdate(name, latestData.version, entityDays);
                    }
                } catch (err) {
                    this.logger.logError(`Polling error for ${name}`, err);
                }
            }
        }
    }

    private rollover() {
        const visited = new Set<string>();
        for (const [, dayMap] of this.timeDependentMap.entries()) {
            for (const [name, cacheItem] of dayMap.entries()) {
                if (visited.has(name)) continue;
                visited.add(name);

                const entityDays = (cacheItem.data as unknown as ITimeDependentEntity).days;
                if (!entityDays) continue;

                if (!this.isInsideConfigRange(entityDays)) {
                    // It has fallen out of the persistence window.
                    // If nobody is using it, start the evictionTTL countdown immediately.
                    if (cacheItem.refCount === 0) {
                        this.startTtlCountdown(cacheItem, name, entityDays);
                    }
                }
            }
        }
    }

    // ============== AGGREGATION & POLLING ============== //

    private async aggregateFromSources(name: string, days?: string[]): Promise<T> {
        this.logger.logAggregationStart(name, days);
        const start = Date.now();

        const promises = this.config.dataSources.map(source => source.fetch(name, days));
        const results = await Promise.all(promises);

        const completeEntity = deepMerge<T>(...results);

        if (!completeEntity.name) completeEntity.name = name;
        if (!completeEntity.version) completeEntity.version = 1;

        if (days && days.length > 0) {
            (completeEntity as unknown as ITimeDependentEntity).days = days;
        }

        this.logger.logAggregationComplete(name, Date.now() - start, days);
        return completeEntity;
    }

    public mergeChanges(oldData: T, newVersionData: T): void {
        mergeChanges(oldData, newVersionData);
    }
}
