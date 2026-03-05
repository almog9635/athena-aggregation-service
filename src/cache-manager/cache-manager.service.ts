import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { CacheConfig } from './interfaces/cache-config.interface';
import type { IEntity, ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger, type ICacheLogger } from './logger/cache-logger.service';
import { deepMerge, mergeChanges } from './utils/merge.util';
import type { CacheItem } from './interfaces/cache-item';
import { CacheErrorMessage } from './enums/error-message.enum';
import { CacheLogMessage } from './enums/log-message.enum';

@Injectable()
export class CacheManager<T extends IEntity> implements OnModuleInit, OnModuleDestroy {

    // Store Time-Independent items: Name -> ID -> CacheItem
    private readonly timeIndependentMap = new Map<string, Map<string, CacheItem<T>>>();

    // Store Time-Dependent items: Day -> Name -> ID -> CacheItem
    private readonly timeDependentMap = new Map<string, Map<string, Map<string, CacheItem<T>>>>();

    // Tracks items that are actively being aggregated (to prevent concurrent identical fetches)
    private readonly pendingAggregations = new Map<string, Promise<T[]>>();
    private readonly fullyLoadedKeys = new Set<string>();

    public readonly onEntityUpdated = new Subject<T>();

    private pollingIntervalId: NodeJS.Timeout | null = null;
    private rolloverIntervalId: NodeJS.Timeout | null = null;

    constructor(
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
        @Inject('CACHE_LOGGER') private readonly logger: ICacheLogger = new DefaultCacheLogger(),
    ) { }

    async onModuleInit() {
        this.startBackgroundTasks();
        await this.preloadConfiguredDays();
    }

    onModuleDestroy() {

        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
        }

        if (this.rolloverIntervalId) {
            clearInterval(this.rolloverIntervalId);
        }

        // Clear all active TTL timers to prevent memory leaks on shutdown
        for (const nameMap of this.timeIndependentMap.values()) {
            for (const item of nameMap.values()) {
                if (item.ttlTimeout) clearTimeout(item.ttlTimeout);
            }
        }
        for (const dayMap of this.timeDependentMap.values()) {
            for (const nameMap of dayMap.values()) {
                for (const item of nameMap.values()) {
                    if (item.ttlTimeout) clearTimeout(item.ttlTimeout);
                }
            }
        }
    }

    /**
     * Acquires all entities of a specific name from the cache.
     * If they haven't been fetched yet, aggregates them from sources.
     */
    async acquire(entityName: string, days?: string[]): Promise<T[]> {
        const aggregationKey = this.getAggregationKey(entityName, days);

        if (this.fullyLoadedKeys.has(aggregationKey)) {
            const results: T[] = [];
            const nameMap = this.getCacheNameMap(entityName, days);

            if (nameMap) {
                for (const item of nameMap.values()) {
                    item.refCount++;
                    this.cancelTtl(item, entityName, item.data.id, days);
                    results.push(item.data);
                }
            }

            this.logger.logHit(entityName, days);

            return results;
        }

        if (this.pendingAggregations.has(aggregationKey)) {
            this.logger.logAggregationStart(`${entityName} (${CacheLogMessage.REUSING_PENDING_PROMISE})`, days);
            const results = await this.pendingAggregations.get(aggregationKey)!;

            for (const res of results) {
                const cachedItem = this.getExistingCacheItem(entityName, res.id, days);
                if (cachedItem) {
                    cachedItem.refCount++;
                    this.cancelTtl(cachedItem, entityName, res.id, days);
                }
            }

            return results;
        }

        this.logger.logMiss(entityName, days);
        this.logger.logAggregationStart(`${entityName} (${CacheLogMessage.NEW_AGGREGATION})`, days);

        const aggregationPromise = this.aggregateFromSources(entityName, days).then((results) => {
            this.fullyLoadedKeys.add(aggregationKey);
            this.pendingAggregations.delete(aggregationKey);

            for (const data of results) {
                const storedItem = this.getExistingCacheItem(entityName, data.id, days);
                if (storedItem) storedItem.refCount++;
            }

            return results;
        }).catch(err => {
            this.pendingAggregations.delete(aggregationKey);
            throw err;
        });

        this.pendingAggregations.set(aggregationKey, aggregationPromise);

        return aggregationPromise;
    }

    /**
     * Acquires multiple entity types from the cache.
     */
    async acquireMultiple(names: string[], days?: string[]): Promise<T[]> {
        const nestedArrays = await Promise.all(names.map(name => this.acquire(name, days)));
        return nestedArrays.flat();
    }

    /**
     * Acquires all entities available for the specified days.
     * Requires data sources to implement `fetchAll()`.
     */
    async acquireAll(days?: string[]): Promise<T[]> {
        this.logger.logAggregationStart(`ACQUIRE_ALL`, days);
        const start = Date.now();

        const nameToIdAndPartials = new Map<string, Map<string, Partial<T>[]>>();

        for (const source of this.config.dataSources) {
            if (source.fetchAll) {
                try {
                    const partials = await source.fetchAll(days);
                    for (const partial of partials) {
                        const entityName = partial.name;
                        const entityId = partial.id;
                        if (entityName && entityId) {
                            if (!nameToIdAndPartials.has(entityName)) {
                                nameToIdAndPartials.set(entityName, new Map<string, Partial<T>[]>());
                            }
                            const idMap = nameToIdAndPartials.get(entityName)!;
                            if (!idMap.has(entityId)) idMap.set(entityId, []);
                            idMap.get(entityId)!.push(partial);
                        }
                    }
                } catch (err) {
                    this.logger.logError(`fetchAll error from source`, err);
                }
            } else {
                this.logger.logError(`A data source does not support fetchAll`, new Error('Method not implemented'));
            }
        }

        const results: T[] = [];
        for (const [name, idMap] of nameToIdAndPartials.entries()) {
            for (const [id, chunks] of idMap.entries()) {
                const completeEntity = deepMerge<T>(...chunks);
                if (!completeEntity.name) completeEntity.name = name;
                if (!completeEntity.id) completeEntity.id = id;
                if (!completeEntity.version) completeEntity.version = 1;

                if (days && days.length > 0) {
                    (completeEntity as unknown as ITimeDependentEntity).days = days;
                }

                let cachedItem = this.getExistingCacheItem(name, id, days);
                if (cachedItem) {
                    this.mergeChanges(cachedItem.data, completeEntity);
                } else {
                    this.storeInCache(completeEntity, name, id, days);
                    cachedItem = this.getExistingCacheItem(name, id, days)!;
                }

                cachedItem.refCount++;
                this.cancelTtl(cachedItem, name, id, days);
                results.push(cachedItem.data);
            }

            const aggregationKey = this.getAggregationKey(name, days);
            this.fullyLoadedKeys.add(aggregationKey);
        }

        this.logger.logAggregationComplete(`ACQUIRE_ALL`, Date.now() - start, days);
        return results;
    }

    /**
     * Releases an entity type. If its refCount drops to 0, it may be scheduled for eviction.
     */
    release(entityName: string, days?: string[]): void {
        const nameMap = this.getCacheNameMap(entityName, days);

        if (!nameMap) {
            this.logger.logError(CacheErrorMessage.RELEASE_NON_EXISTENT, { name: entityName, days });
            return;
        }

        const isTimeDependent = days && days.length > 0;
        const isInsideRange = isTimeDependent && this.isInsideConfigRange(days);

        for (const [id, cacheItem] of nameMap.entries()) {
            if (cacheItem.refCount > 0) {
                cacheItem.refCount--;
            }

            if (cacheItem.refCount === 0) {
                if (!isTimeDependent || !isInsideRange) {
                    this.startTtlCountdown(cacheItem, entityName, id, days);
                }
            }
        }
    }

    // ============== PRIVATE HELPERS ============== //

    private getAggregationKey(entityName: string, days?: string[]): string {
        return days && days.length > 0 ? `${entityName}#${days.join('#')}` : entityName;
    }

    private getCacheNameMap(entityName: string, days?: string[]): Map<string, CacheItem<T>> | undefined {
        if (!days || days.length === 0) {
            return this.timeIndependentMap.get(entityName);
        }

        // Return mapping from the first day since it holds precise memory references to all others
        const dayMap = this.timeDependentMap.get(days[0]);
        return dayMap ? dayMap.get(entityName) : undefined;
    }

    private getExistingCacheItem(entityName: string, id: string, days?: string[]): CacheItem<T> | undefined {
        const nameMap = this.getCacheNameMap(entityName, days);
        return nameMap ? nameMap.get(id) : undefined;
    }

    private storeInCache(data: T, entityName: string, id: string, days?: string[]): void {
        const newItem: CacheItem<T> = {
            data,
            refCount: 0,
            ttlTimeout: null
        };

        if (!days || days.length === 0) {
            if (!this.timeIndependentMap.has(entityName)) {
                this.timeIndependentMap.set(entityName, new Map<string, CacheItem<T>>());
            }
            this.timeIndependentMap.get(entityName)!.set(id, newItem);
        } else {
            for (const day of days) {
                if (!this.timeDependentMap.has(day)) {
                    this.timeDependentMap.set(day, new Map<string, Map<string, CacheItem<T>>>());
                }
                const dayMap = this.timeDependentMap.get(day)!;
                if (!dayMap.has(entityName)) {
                    dayMap.set(entityName, new Map<string, CacheItem<T>>());
                }
                dayMap.get(entityName)!.set(id, newItem);
            }
        }
    }

    private cancelTtl(item: CacheItem<T>, entityName: string, id: string, days?: string[]) {
        if (item.ttlTimeout) {
            clearTimeout(item.ttlTimeout);
            item.ttlTimeout = null;
            this.logger.logTtlCancel(`${entityName}:${id}`, days);
        }
    }

    private startTtlCountdown(item: CacheItem<T>, entityName: string, id: string, days?: string[]): void {
        if (item.ttlTimeout) return;

        this.logger.logTtlStart(`${entityName}:${id}`, this.config.ttlMs, days);

        item.ttlTimeout = setTimeout(() => {
            this.evict(entityName, id, days);
        }, this.config.ttlMs);
    }

    private evict(name: string, id: string, days?: string[]): void {
        if (!days || days.length === 0) {
            const nameMap = this.timeIndependentMap.get(name);
            if (nameMap) {
                nameMap.delete(id);
                if (nameMap.size === 0) this.timeIndependentMap.delete(name);
            }
        } else {
            for (const day of days) {
                const dayMap = this.timeDependentMap.get(day);
                if (dayMap) {
                    const nameMap = dayMap.get(name);
                    if (nameMap) {
                        nameMap.delete(id);
                        if (nameMap.size === 0) dayMap.delete(name);
                    }
                    if (dayMap.size === 0) this.timeDependentMap.delete(day);
                }
            }
        }

        const aggregationKey = this.getAggregationKey(name, days);
        this.fullyLoadedKeys.delete(aggregationKey);
        this.logger.logEviction(`${name}:${id}`, days);
    }

    private getConfiguredTimeBounds(): { validStartMs: number, validEndMs: number, msPerDay: number } | null {
        if (!this.config.timeRange) return null;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dayOfWeek = new Date(startOfToday).getDay();
        const msPerDay = 1000 * 60 * 60 * 24;

        const startOfWeekMs = startOfToday - (dayOfWeek * msPerDay);
        const endOfWeekMs = startOfWeekMs + (6 * msPerDay);

        const { pastDays, futureDays } = this.config.timeRange;
        const validStartMs = startOfWeekMs - (pastDays * msPerDay);
        const validEndMs = endOfWeekMs + (futureDays * msPerDay);

        return { validStartMs, validEndMs, msPerDay };
    }

    private getConfiguredDays(): string[] {
        const bounds = this.getConfiguredTimeBounds();
        if (!bounds) return [];
        const { validStartMs, validEndMs, msPerDay } = bounds;

        const days: string[] = [];
        for (let t = validStartMs; t <= validEndMs; t += msPerDay) {
            const date = new Date(t);
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            days.push(`${yyyy}-${mm}-${dd}`);
        }
        return days;
    }

    private isInsideConfigRange(days: string[]): boolean {
        const bounds = this.getConfiguredTimeBounds();
        if (!bounds) return false;

        const { validStartMs, validEndMs } = bounds;

        for (const day of days) {
            const date = new Date(day);
            if (Number.isNaN(date.getTime())) return false;

            const time = date.getTime();
            if (time < validStartMs || time > validEndMs) return false;
        }
        return true;
    }

    private async preloadConfiguredDays() {
        if (!this.config.timeRange) return;

        const days = this.getConfiguredDays();
        if (days.length === 0) return;

        this.logger.logAggregationStart(`PRELOAD_CURRENT_WEEK`, days);
        const start = Date.now();

        const nameToIdAndPartials = new Map<string, Map<string, Partial<T>[]>>();

        for (const source of this.config.dataSources) {
            if (source.fetchAll) {
                try {
                    const partials = await source.fetchAll(days);
                    for (const partial of partials) {
                        const entityName = partial.name;
                        const entityId = partial.id;
                        if (entityName && entityId) {
                            if (!nameToIdAndPartials.has(entityName)) {
                                nameToIdAndPartials.set(entityName, new Map<string, Partial<T>[]>());
                            }
                            const idMap = nameToIdAndPartials.get(entityName)!;
                            if (!idMap.has(entityId)) idMap.set(entityId, []);
                            idMap.get(entityId)!.push(partial);
                        }
                    }
                } catch (err) {
                    this.logger.logError(`Preload fetchAll error from source`, err);
                }
            }
        }

        for (const [name, idMap] of nameToIdAndPartials.entries()) {
            for (const [id, chunks] of idMap.entries()) {
                const completeEntity = deepMerge<T>(...chunks);
                if (!completeEntity.name) completeEntity.name = name;
                if (!completeEntity.id) completeEntity.id = id;
                if (!completeEntity.version) completeEntity.version = 1;

                if (days && days.length > 0) {
                    (completeEntity as unknown as ITimeDependentEntity).days = days;
                }

                const existing = this.getExistingCacheItem(name, id, days);
                if (existing) {
                    this.mergeChanges(existing.data, completeEntity);
                } else {
                    this.storeInCache(completeEntity, name, id, days);
                }
            }

            const aggregationKey = this.getAggregationKey(name, days);
            this.fullyLoadedKeys.add(aggregationKey);
        }

        this.logger.logAggregationComplete(`PRELOAD_CURRENT_WEEK`, Date.now() - start, days);
    }

    private startBackgroundTasks() {
        if (this.config.pollingIntervalMs > 0) {
            this.pollingIntervalId = setInterval(() => this.poll(), this.config.pollingIntervalMs);
        }

        const hourMs = 1000 * 60 * 60 * 24;
        this.rolloverIntervalId = setInterval(() => this.rollover(), hourMs);
    }

    private async poll() {
        const indepKeys = Array.from(this.timeIndependentMap.keys());
        for (const name of indepKeys) {
            const nameMap = this.timeIndependentMap.get(name)!;
            const idsToUpdate: string[] = [];
            for (const [id, item] of nameMap.entries()) {
                if (!item.ttlTimeout) idsToUpdate.push(id);
            }
            if (idsToUpdate.length > 0) {
                await this.executePollFetch(name, idsToUpdate);
            }
        }

        for (const [, dayMap] of this.timeDependentMap.entries()) {
            for (const [name, nameMap] of dayMap.entries()) {
                const idsToUpdate: string[] = [];
                let entityDays: string[] | undefined;

                for (const [id, item] of nameMap.entries()) {
                    if (!item.ttlTimeout) {
                        idsToUpdate.push(id);
                        entityDays ??= (item.data as unknown as ITimeDependentEntity).days;
                    }
                }

                if (idsToUpdate.length > 0) {
                    await this.executePollFetch(name, idsToUpdate, entityDays);
                }
            }
        }
    }

    private async executePollFetch(name: string, ids: string[], days?: string[]) {
        let fetchedPartials: Partial<T>[] = [];
        try {
            for (const source of this.config.dataSources) {
                if (source.fetchByIds) {
                    const partials = await source.fetchByIds(name, ids, days);
                    fetchedPartials.push(...partials);
                } else {
                    const partials = await source.fetch(name, days);
                    const filtered = partials.filter(p => p.id && ids.includes(p.id));
                    fetchedPartials.push(...filtered);
                }
            }
        } catch (err) {
            this.logger.logError(`${CacheErrorMessage.POLLING_ERROR} ${name}`, err);
            return;
        }

        const entityMap = new Map<string, Partial<T>[]>();
        for (const p of fetchedPartials) {
            if (p.id) {
                if (!entityMap.has(p.id)) entityMap.set(p.id, []);
                entityMap.get(p.id)!.push(p);
            }
        }

        for (const [id, chunks] of entityMap.entries()) {
            const completeEntity = deepMerge<T>(...chunks);
            const cacheItem = this.getExistingCacheItem(name, id, days);

            if (cacheItem && completeEntity.version !== undefined && completeEntity.version > cacheItem.data.version) {
                this.mergeChanges(cacheItem.data, completeEntity as T);
                this.logger.logPollingUpdate(`${name}:${id}`, completeEntity.version, days);
                this.onEntityUpdated.next(cacheItem.data);
            }
        }
    }

    private rollover() {
        const visitedNames = new Set<string>();

        for (const [, dayMap] of this.timeDependentMap.entries()) {
            for (const [name, nameMap] of dayMap.entries()) {
                if (visitedNames.has(name)) continue;
                visitedNames.add(name);

                for (const [id, cacheItem] of nameMap.entries()) {
                    const entityDays = (cacheItem.data as unknown as ITimeDependentEntity).days;
                    if (!entityDays) continue;

                    if (!this.isInsideConfigRange(entityDays)) {
                        if (cacheItem.refCount === 0) {
                            this.startTtlCountdown(cacheItem, name, id, entityDays);
                        }
                    }
                }
            }
        }
    }

    // ============== AGGREGATION & POLLING ============== //

    private async aggregateFromSources(entityName: string, days?: string[]): Promise<T[]> {
        const start = Date.now();
        const entityMap = new Map<string, Partial<T>[]>();

        for (const source of this.config.dataSources) {
            try {
                const partials = await source.fetch(entityName, days);

                for (const partial of partials) {
                    if (partial?.id) {
                        if (!entityMap.has(partial.id)) {
                            entityMap.set(partial.id, []);
                        }
                        entityMap.get(partial.id)!.push(partial);
                    }
                }
            } catch (err) {
                this.logger.logError(`Aggregation fetch error for ${entityName}`, err);
            }
        }

        const completeEntities: T[] = [];
        const entityIds: string[] = [];

        for (const [id, partialChunks] of entityMap.entries()) {
            const completeEntity = deepMerge<T>(...partialChunks);
            if (!completeEntity.name) completeEntity.name = entityName;
            if (!completeEntity.id) completeEntity.id = id;
            if (!completeEntity.version) completeEntity.version = 1;

            if (days && days.length > 0) {
                (completeEntity as unknown as ITimeDependentEntity).days = days;
            }

            const existing = this.getExistingCacheItem(entityName, id, days);
            if (existing) {
                this.mergeChanges(existing.data, completeEntity as T);
                completeEntities.push(existing.data);
            } else {
                this.storeInCache(completeEntity as T, entityName, id, days);
                completeEntities.push(this.getExistingCacheItem(entityName, id, days)!.data);
            }
            entityIds.push(id);
        }

        this.logger.logAggregationComplete(entityName, Date.now() - start, days);

        if (this.config.relations && this.config.relations[entityName] && entityIds.length > 0) {
            const relatedNames = this.config.relations[entityName];

            this.fetchAndStoreAssociatedEntities(relatedNames, entityIds, days).catch(err => {
                this.logger.logError('Associated Entities Fetch Error', err);
            });
        }

        return completeEntities;
    }

    private async fetchAndStoreAssociatedEntities(relatedNames: string[], ids: string[], days?: string[]): Promise<void> {
        for (const relatedName of relatedNames) {
            const entityMap = new Map<string, Partial<T>[]>();

            for (const source of this.config.dataSources) {
                if (source.fetchByIds) {
                    try {
                        const partials = await source.fetchByIds(relatedName, ids, days);
                        for (const partial of partials) {
                            if (partial && partial.id) {
                                if (!entityMap.has(partial.id)) entityMap.set(partial.id, []);
                                entityMap.get(partial.id)!.push(partial);
                            }
                        }
                    } catch (err) {
                        this.logger.logError(`Assoc Fetch error for ${relatedName}`, err);
                    }
                } else {
                    try {
                        const partials = await source.fetch(relatedName, days);
                        for (const partial of partials) {
                            if (partial && partial.id && ids.includes(partial.id)) {
                                if (!entityMap.has(partial.id)) entityMap.set(partial.id, []);
                                entityMap.get(partial.id)!.push(partial);
                            }
                        }
                    } catch (err) {
                        this.logger.logError(`Assoc Fetch fallback error for ${relatedName}`, err);
                    }
                }
            }

            for (const [id, partialChunks] of entityMap.entries()) {
                const completeEntity = deepMerge<T>(...partialChunks);
                if (!completeEntity.name) completeEntity.name = relatedName;
                if (!completeEntity.id) completeEntity.id = id;
                if (!completeEntity.version) completeEntity.version = 1;

                if (days && days.length > 0) {
                    (completeEntity as unknown as ITimeDependentEntity).days = days;
                }

                const existing = this.getExistingCacheItem(relatedName, id, days);
                if (existing) {
                    this.mergeChanges(existing.data, completeEntity as T);
                } else {
                    this.storeInCache(completeEntity as T, relatedName, id, days);
                }
            }

            const aggregationKey = this.getAggregationKey(relatedName, days);
            this.fullyLoadedKeys.add(aggregationKey);
        }
    }

    private mergeChanges(target: T, source: T): void {
        mergeChanges(target, source);
    }
}
