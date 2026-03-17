import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { CacheConfig } from './interfaces/cache-config.interface';
import type { IEntity, ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger, type ICacheLogger } from './logger/cache-logger.service';
// import { deepMerge } from './utils/merge.util';
import { mergeChanges } from './utils/merge.util';
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

    /**
     * Discovery Map: Tracks which filters are currently being watched by users.
     * Maps aggregationKey -> filter metadata.
     * We use this to re-fetch root queries in the background to discover "newly created" entities.
     */
    private readonly activeRootSubscriptions = new Map<string, {
        entityName: string;
        days?: string[];
        dataGroups: Map<string, number>; // dataGroupName -> refCount
        subscriberFilters?: Record<string, any>;
        lastDiscoveryTime: number;
    }>();

    public readonly onEntityUpdated = new Subject<T>();

    private readonly lastPollTimes = new Map<string, number>();
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
                if (item.ttlTimeout) {
                    clearTimeout(item.ttlTimeout);
                }
            }
        }

        for (const dayMap of this.timeDependentMap.values()) {
            for (const nameMap of dayMap.values()) {
                for (const item of nameMap.values()) {
                    if (item.ttlTimeout) {
                        clearTimeout(item.ttlTimeout);
                    }
                }
            }
        }
    }

    /**
     * Acquires all entities of a specific name from the cache.
     * If they haven't been fetched yet, aggregates them from sources.
     */
    async acquire(entityName: string, days?: string[], dataGroup?: string,
        requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<T[]> {
        const aggregationKey = this.getAggregationKey(entityName, days, subscriberFilters);

        if (this.fullyLoadedKeys.has(aggregationKey)) {
            const resultsMap = new Map<string, T>();
            const dayList = (days && days.length > 0) ? days : [undefined];
            let isUnderFetched = false;

            for (const day of dayList) {
                const nameMap = this.getCacheNameMap(entityName, day);
                if (nameMap) {
                    for (const item of nameMap.values()) {
                        if (dataGroup) {
                            const existing = item.activeGroups.get(dataGroup);
                            if (existing) {
                                existing.refCount += 1;
                                // Merge requested fields if they ask for more
                                if (requestedFields) {
                                    existing.fields = [...new Set([...existing.fields, ...requestedFields])];
                                }
                            } else {
                                item.activeGroups.set(dataGroup, { fields: requestedFields || [], refCount: 1 });
                            }
                        }
                        this.registerRootSubscription(entityName, aggregationKey, days, dataGroup, subscriberFilters);
                        this.cancelTtl(item, entityName, item.data.id, days);
                        resultsMap.set(item.data.id, item.data);
                    }
                }
            }

            // Detect Under-fetching
            if (requestedFields && requestedFields.length > 0) {
                for (const item of resultsMap.values()) {
                    const cachedItem = this.getExistingCacheItem(entityName, (item as any).id, days);
                    if (cachedItem) {
                        const allCachedFields = new Set<string>();
                        for (const group of cachedItem.activeGroups.values()) {
                            group.fields.forEach(f => allCachedFields.add(f));
                        }

                        for (const field of requestedFields) {
                            if (!allCachedFields.has(field)) {
                                isUnderFetched = true;
                                break;
                            }
                        }
                    }
                    if (isUnderFetched) break;
                }
            }

            if (!isUnderFetched) {
                // If we have a hit, we still need to register the root subscription for discovery
                this.registerRootSubscription(entityName, aggregationKey, days, dataGroup, subscriberFilters);

                this.logger.logHit(entityName, days);
                return Array.from(resultsMap.values());
            } else {
                this.logger.logMiss(`${entityName} (Under-fetched fields)`, days);
                // Deliberately drop the fully loaded key to force a re-aggregation that includes the missing fields.
                this.fullyLoadedKeys.delete(aggregationKey);
            }
        }

        const pendingPromise = this.pendingAggregations.get(aggregationKey);
        if (pendingPromise) {
            this.logger.logAggregationStart(`${entityName} (${CacheLogMessage.REUSING_PENDING_PROMISE})`, days);
            const results = await pendingPromise;

            for (const res of results) {
                const cachedItem = this.getExistingCacheItem(entityName, res.id, days);
                if (cachedItem) {
                    if (dataGroup) {
                        const existing = cachedItem.activeGroups.get(dataGroup);
                        if (existing) {
                            existing.refCount += 1;
                            if (requestedFields) {
                                existing.fields = [...new Set([...existing.fields, ...requestedFields])];
                            }
                        } else {
                            cachedItem.activeGroups.set(dataGroup, { fields: requestedFields || [], refCount: 1 });
                        }
                    }
                    this.registerRootSubscription(entityName, aggregationKey, days, dataGroup, subscriberFilters);
                    this.cancelTtl(cachedItem, entityName, res.id, days);
                }
            }

            return results;
        }

        this.logger.logMiss(entityName, days);
        this.logger.logAggregationStart(`${entityName} (${CacheLogMessage.NEW_AGGREGATION})`, days);

        const aggregationPromise = this.aggregateFromSources(entityName, days, dataGroup, requestedFields, subscriberFilters).then((results) => {
            this.fullyLoadedKeys.add(aggregationKey);
            this.pendingAggregations.delete(aggregationKey);

            for (const data of results) {
                const storedItem = this.getExistingCacheItem(entityName, data.id, days);
                if (storedItem && dataGroup) {
                    const existing = storedItem.activeGroups.get(dataGroup);
                    if (existing) {
                        existing.refCount += 1;
                        if (requestedFields) {
                            existing.fields = [...new Set([...existing.fields, ...requestedFields])];
                        }
                    } else {
                        storedItem.activeGroups.set(dataGroup, { fields: requestedFields || [], refCount: 1 });
                    }
                }
            }
            this.registerRootSubscription(entityName, aggregationKey, days, dataGroup, subscriberFilters);

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
    async acquireMultiple(names: string[], days?: string[], dataGroup?: string, requestedFieldsMap?: Map<string, string[]>, subscriberFilters?: Record<string, any>): Promise<T[]> {
        const nestedArrays = await Promise.all(names.map(name => {
            const reqFields = requestedFieldsMap ? requestedFieldsMap.get(name) : undefined;
            return this.acquire(name, days, dataGroup, reqFields, subscriberFilters);
        }));
        return nestedArrays.flat();
    }

    /**
     * Acquires all entities available for the specified days.
     * Requires data sources to implement `fetchAll()`.
     */
    async acquireAll(days?: string[], dataGroup?: string, requestedFields?: string[]): Promise<T[]> {
        this.logger.logAggregationStart(`ACQUIRE_ALL`, days);
        const start = Date.now();

        const nameToIdAndFragments = new Map<string, Map<string, Partial<T>>>();

        const source = this.config.dataSource;
        if (source.fetchAll) {
            try {
                const entityFragments = await source.fetchAll(days);
                for (const fragment of entityFragments) {
                    const entityName = fragment.name;
                    const entityId = fragment.id;
                    if (entityName && entityId) {
                        let idMap = nameToIdAndFragments.get(entityName);
                        if (!idMap) {
                            idMap = new Map<string, Partial<T>>();
                            nameToIdAndFragments.set(entityName, idMap);
                        }

                        idMap.set(entityId, fragment);
                    }
                }
            } catch (err) {
                this.logger.logError(`fetchAll error from source`, err);
            }
        } else {
            this.logger.logError(`Data source does not support fetchAll`, new Error('Method not implemented'));
        }

        const results: T[] = [];
        for (const [name, idMap] of nameToIdAndFragments.entries()) {
            for (const [id, fragment] of idMap.entries()) {
                // deepMerge is commented out as entities from the unified GraphQL schema are no longer fragmented across multiple sources
                // const completeEntity = deepMerge<T>(...chunks);
                const completeEntity = fragment as T;

                this.ensureEntityContract(completeEntity, name, id, days);

                let cachedItem = this.getExistingCacheItem(name, id, days);
                if (cachedItem) {
                    mergeChanges(cachedItem.data, completeEntity);
                } else {
                    this.storeInCache(completeEntity, name, id, days);
                    cachedItem = this.getExistingCacheItem(name, id, days)!;
                }

                if (cachedItem && dataGroup) {
                    const existing = cachedItem.activeGroups.get(dataGroup);
                    if (existing) {
                        existing.refCount += 1;
                        if (requestedFields) {
                            existing.fields = [...new Set([...existing.fields, ...requestedFields])];
                        }
                    } else {
                        cachedItem.activeGroups.set(dataGroup, { fields: requestedFields || [], refCount: 1 });
                    }
                }
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
     * Releases an entity type for a specific dataGroup. If nobody is active, it may be scheduled for eviction.
     * Use filters to ensure you only release entities belonging to the disconnecting user.
     * Use specificIds to strictly target entities for explicit disposal (e.g. Relation Disposal).
     */
    release(entityName: string, days?: string[], dataGroup?: string, subscriberFilters?: Record<string, any>, specificIds?: string[], visitedIds?: Set<string>): void {
        const resultsMap = new Map<string, CacheItem<T>>();
        const dayList = (days && days.length > 0) ? days : [undefined];

        for (const day of dayList) {
            const nameMap = this.getCacheNameMap(entityName, day);
            if (nameMap) {
                for (const item of nameMap.values()) {
                    resultsMap.set(item.data.id, item);
                }
            }
        }

        // 1. Cleanup root tracking if this is a root release
        if (dataGroup && !specificIds && !visitedIds) {
            const aggregationKey = this.getAggregationKey(entityName, days, subscriberFilters);
            this.deregisterRootSubscription(aggregationKey, dataGroup);
        }

        const visited = visitedIds || new Set<string>();

        if (resultsMap.size === 0) {
            this.logger.logError(CacheErrorMessage.RELEASE_NON_EXISTENT, { name: entityName, days });
            return;
        }

        const isTimeDependent = days && days.length > 0;
        const isInsidePollingRange = isTimeDependent && this.isInsideConfigRange(days, this.config.pollingTimeRange);

        for (const [id, cacheItem] of resultsMap.entries()) {
            // Target eviction
            if (specificIds && specificIds.length > 0 && !specificIds.includes(id)) {
                continue;
            }

            if (subscriberFilters) {
                let matches = true;
                for (const [key, value] of Object.entries(subscriberFilters)) {
                    if ((cacheItem.data as any)[key] !== value &&
                        (!Array.isArray(value) || !value.includes((cacheItem.data as any)[key]))) {
                        matches = false;
                        break;
                    }
                }
                if (!matches) continue;
            }

            if (dataGroup) {
                const existing = cacheItem.activeGroups.get(dataGroup);
                if (existing) {
                    existing.refCount -= 1;
                    if (existing.refCount <= 0) {
                        cacheItem.activeGroups.delete(dataGroup);
                    }
                }
            } else if (!dataGroup) {
                cacheItem.activeGroups.clear();
            }

            if (cacheItem.activeGroups.size === 0) {
                if (!isTimeDependent || !isInsidePollingRange) {
                    this.startTtlCountdown(cacheItem, entityName, id, days);
                }
            }

            // 3. Recursive Release: Release children that were auto-fetched for this entity
            const childTypes = this.config.relations?.[entityName];
            if (childTypes) {
                for (const childType of childTypes) {
                    const childIds = this.extractChildIds(cacheItem.data, childType);
                    if (childIds.length > 0) {
                        this.release(childType, days, dataGroup, undefined, childIds, visited);
                    }
                }
            }
        }
    }


    // ============== PRIVATE HELPERS ============== //

    private ensureEntityContract(entity: T, name: string, id: string, days?: string[]): void {
        if (!entity.name) {
            entity.name = name;
        }

        if (!entity.id) {
            entity.id = id;
        }

        if (!entity.version) {
            entity.version = 1;
        }

        if (days && days.length > 0) {
            (entity as unknown as ITimeDependentEntity).days = days;
        }
    }

    private getAggregationKey(entityName: string, days?: string[], subscriberFilters?: Record<string, any>): string {
        let key = days && days.length > 0 ? `${entityName}#${days.join('#')}` : entityName;
        if (subscriberFilters && Object.keys(subscriberFilters).length > 0) {
            // Hash the filters object to ensure isolation between different tenants/squadrons
            const filterHash = Buffer.from(JSON.stringify(subscriberFilters)).toString('base64');
            key += `#${filterHash}`;
        }
        return key;
    }

    private getCacheNameMap(entityName: string, day?: string): Map<string, CacheItem<T>> | undefined {
        if (!day) {
            return this.timeIndependentMap.get(entityName);
        }

        const dayMap = this.timeDependentMap.get(day);
        return dayMap ? dayMap.get(entityName) : undefined;
    }

    private getExistingCacheItem(entityName: string, id: string, days?: string[]): CacheItem<T> | undefined {
        const dayList = (days && days.length > 0) ? days : [undefined];
        for (const day of dayList) {
            const nameMap = this.getCacheNameMap(entityName, day);
            const item = nameMap?.get(id);
            if (item) return item;
        }
        return undefined;
    }

    private storeInCache(data: T, entityName: string, id: string, days?: string[]): void {
        const newItem: CacheItem<T> = {
            data,
            activeGroups: new Map<string, { fields: string[], refCount: number }>(),
            ttlTimeout: null
        };

        if (!days || days.length === 0) {
            let nameMap = this.timeIndependentMap.get(entityName);

            if (!nameMap) {
                nameMap = new Map<string, CacheItem<T>>();
                this.timeIndependentMap.set(entityName, nameMap);
            }

            nameMap.set(id, newItem);
        } else {
            for (const day of days) {
                let dayMap = this.timeDependentMap.get(day);

                if (!dayMap) {
                    dayMap = new Map<string, Map<string, CacheItem<T>>>();
                    this.timeDependentMap.set(day, dayMap);
                }

                let nameMap = dayMap.get(entityName);

                if (!nameMap) {
                    nameMap = new Map<string, CacheItem<T>>();
                    dayMap.set(entityName, nameMap);
                }

                nameMap.set(id, newItem);
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

                if (nameMap.size === 0) {
                    this.timeIndependentMap.delete(name);
                }
            }
        } else {
            for (const day of days) {
                const dayMap = this.timeDependentMap.get(day);

                if (dayMap) {
                    const nameMap = dayMap.get(name);

                    if (nameMap) {
                        nameMap.delete(id);

                        if (nameMap.size === 0) {
                            dayMap.delete(name);
                        }
                    }

                    if (dayMap.size === 0) {
                        this.timeDependentMap.delete(day);
                    }
                }
            }
        }

        const aggregationKey = this.getAggregationKey(name, days);
        this.fullyLoadedKeys.delete(aggregationKey);
        this.logger.logEviction(`${name}:${id}`, days);
    }

    private getConfiguredTimeBounds(timeRange?: typeof this.config.pollingTimeRange): { validStartMs: number, validEndMs: number, msPerDay: number } | null {
        if (!timeRange) {
            return null;
        }

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dayOfWeek = new Date(startOfToday).getDay();
        const msPerDay = 1000 * 60 * 60 * 24;

        const startOfWeekMs = startOfToday - (dayOfWeek * msPerDay);
        const endOfWeekMs = startOfWeekMs + (6 * msPerDay);

        const { pastDays, futureDays } = timeRange;
        const validStartMs = startOfWeekMs - (pastDays * msPerDay);
        const validEndMs = endOfWeekMs + (futureDays * msPerDay);

        return { validStartMs, validEndMs, msPerDay };
    }

    private getConfiguredDays(timeRange?: typeof this.config.pollingTimeRange): string[] {
        const bounds = this.getConfiguredTimeBounds(timeRange);
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

    private isInsideConfigRange(days: string[], timeRange?: typeof this.config.pollingTimeRange): boolean {
        const bounds = this.getConfiguredTimeBounds(timeRange);

        if (!bounds) {
            return false;
        }

        const { validStartMs, validEndMs } = bounds;

        for (const day of days) {
            const date = new Date(day);

            if (Number.isNaN(date.getTime())) {
                return false;
            }

            const time = date.getTime();

            if (time < validStartMs || time > validEndMs) {
                return false;
            }
        }
        return true;
    }

    private async preloadConfiguredDays() {
        if (!this.config.pollingTimeRange) {
            return;
        }

        const days = this.getConfiguredDays(this.config.pollingTimeRange);

        if (days.length === 0) {
            return;
        }

        this.logger.logAggregationStart(`PRELOAD_CURRENT_WEEK`, days);
        const start = Date.now();

        const nameToIdAndFragments = new Map<string, Map<string, Partial<T>>>();
        const source = this.config.dataSource;

        if (source.fetchAll) {
            try {
                const entityFragments = await source.fetchAll(days);

                for (const fragment of entityFragments) {
                    const entityName = fragment.name;
                    const entityId = fragment.id;

                    if (entityName && entityId) {
                        let idMap = nameToIdAndFragments.get(entityName);

                        if (!idMap) {
                            idMap = new Map<string, Partial<T>>();
                            nameToIdAndFragments.set(entityName, idMap);
                        }

                        idMap.set(entityId, fragment);
                    }
                }
            } catch (err) {
                this.logger.logError(`Preload fetchAll error from source`, err);
            }
        }

        for (const [name, idMap] of nameToIdAndFragments.entries()) {
            for (const [id, fragment] of idMap.entries()) {
                // deepMerge is commented out as entities from the unified GraphQL schema are no longer fragmented across multiple sources
                // const completeEntity = deepMerge<T>(...chunks);
                const completeEntity = fragment as T;

                this.ensureEntityContract(completeEntity, name, id, days);

                const existing = this.getExistingCacheItem(name, id, days);

                if (existing) {
                    mergeChanges(existing.data, completeEntity, (removedTypename, removedId) => {
                        this.logger.logRelationDisposal(removedTypename, removedId);
                        // Release the child from all active data groups that the parent holds to trigger TTL eviction
                        if (existing.activeGroups) {
                            for (const group of existing.activeGroups.keys()) {
                                this.release(removedTypename, days, group, undefined, [removedId]);
                            }
                        }
                    });
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
        if (this.config.pollingIntervalMs > 0 ||
            (this.config.entitySettings && Object.keys(this.config.entitySettings).length > 0)) {
            const tickRate = this.config.baseTickMs && this.config.baseTickMs > 0 ? this.config.baseTickMs : 5000;
            this.pollingIntervalId = setInterval(() => this.pollTick(), tickRate);
        }

        const hourMs = 1000 * 60 * 60 * 24;
        this.rolloverIntervalId = setInterval(() => this.rollover(), hourMs);
    }

    private getEntityPollingInterval(entityName: string): number {
        return this.config?.entitySettings?.[entityName]?.pollingIntervalMs ?? this.config.pollingIntervalMs;
    }

    private getDiscoveryInterval(entityName: string): number {
        return this.config?.entitySettings?.[entityName]?.discoveryIntervalMs ?? 
               this.config.discoveryIntervalMs ?? 
               this.getEntityPollingInterval(entityName);
    }

    private getParentsOf(entityName: string): string[] {
        const parents: string[] = [];

        if (!this.config.relations) {
            return parents;
        }

        for (const [parent, children] of Object.entries(this.config.relations)) {
            if (children.includes(entityName)) {
                parents.push(parent);
            }
        }

        return parents;
    }

    private async pollTick() {
        const now = Date.now();

        // 1. Discovery Phase: Re-aggregate root queries to find "new" entities
        for (const sub of this.activeRootSubscriptions.values()) {
            const lastDiscovery = sub.lastDiscoveryTime || 0;
            const discoveryInterval = this.getDiscoveryInterval(sub.entityName);

            if (now - lastDiscovery >= discoveryInterval) {
                sub.lastDiscoveryTime = now;
                // We pick one dataGroup from the set to use as the "primary" trigger for field inheritance
                const dataGroup = sub.dataGroups.keys().next().value;

                await this.aggregateFromSources(sub.entityName, sub.days, dataGroup, undefined, sub.subscriberFilters).catch(err => {
                    this.logger.logError(`Discovery error for ${sub.entityName}`, err);
                });
            }
        }

        const activeEntities = new Set<string>();

        for (const name of this.timeIndependentMap.keys()) {
            activeEntities.add(name);
        }

        for (const dayMap of this.timeDependentMap.values()) {
            for (const name of dayMap.keys()) {
                activeEntities.add(name);
            }
        }

        for (const name of activeEntities) {
            const interval = this.getEntityPollingInterval(name);
            const lastPoll = this.lastPollTimes.get(name) || 0;

            if (now - lastPoll >= interval) {
                // Parent-First Relation Polling:
                // If this entity has parents, poll them first to discover any newly added IDs.
                const parents = this.getParentsOf(name);
                for (const parent of parents) {
                    if (activeEntities.has(parent)) {
                        const parentLastPoll = this.lastPollTimes.get(parent) || 0;
                        // Avoid double-polling if parent was already polled very recently in this tick
                        if (now - parentLastPoll > 1000) {
                            await this.pollEntity(parent);
                            this.lastPollTimes.set(parent, now);
                        }
                    }
                }

                // Now poll the child entity itself. Any newly discovered IDs from the parent poll
                // will have been stored as fragments and will be picked up here!
                if (now - (this.lastPollTimes.get(name) || 0) > 1000) {
                    this.lastPollTimes.set(name, now);
                    await this.pollEntity(name);
                }
            }
        }
    }

    private async pollEntity(name: string) {
        const indepMap = this.timeIndependentMap.get(name);

        if (indepMap) {
            const idsToUpdate: string[] = [];

            for (const [id, item] of indepMap.entries()) {
                if (!item.ttlTimeout) idsToUpdate.push(id);
            }

            if (idsToUpdate.length > 0) {
                await this.executePollFetch(name, idsToUpdate);
            }
            return;
        }

        const processedIds = new Set<string>();

        for (const dayMap of this.timeDependentMap.values()) {
            const nameMap = dayMap.get(name);

            if (nameMap) {
                const idsParams = new Map<string, { ids: string[], days: string[], fields: string[] }>();

                // loops over all the instances of the current day
                for (const [id, item] of nameMap.entries()) {
                    if (!item.ttlTimeout && !processedIds.has(id)) {
                        processedIds.add(id);

                        // this takes the fields that are currently active by using the dataGroups
                        const unifiedFields = Array.from(item.activeGroups.values()).map(group => group.fields).flat();
                        const uniqueFields = [...new Set(unifiedFields)];

                        const entityDays = (item.data as unknown as ITimeDependentEntity).days;
                        let shouldPoll = true;

                        if (entityDays && entityDays.length > 0) {
                            const isPolling = this.isInsideConfigRange(entityDays, this.config.pollingTimeRange);

                            // if the entity is not inside the polling time range, check if it is inside the on demand time range
                            if (!isPolling) {
                                const isOnDemand = this.config.onDemandTimeRange ? this.isInsideConfigRange(entityDays, this.config.onDemandTimeRange) : false;

                                // if the entity is not inside the on demand time range, don't poll it
                                if (!isOnDemand || item.activeGroups.size === 0) {
                                    shouldPoll = false;
                                }
                            }
                        }

                        if (!shouldPoll) {
                            continue;
                        }

                        const daysKey = entityDays ? entityDays.join('#') : 'none';
                        let existingParams = idsParams.get(daysKey);

                        if (existingParams) {
                            // Merge union
                            existingParams.fields = [...new Set([...existingParams.fields, ...uniqueFields])];
                        } else {
                            existingParams = { ids: [], days: entityDays || [], fields: uniqueFields };
                            idsParams.set(daysKey, existingParams);
                        }

                        existingParams.ids.push(id);
                    }
                }

                for (const params of idsParams.values()) {
                    if (params.ids.length > 0) {
                        await this.executePollFetch(name, params.ids, params.days, params.fields.length > 0 ? params.fields : undefined);
                    }
                }
            }
        }
    }

    private async executePollFetch(name: string, ids: string[], days?: string[], fields?: string[]) {
        let fetchedFragments: Partial<T>[] = [];

        // fetching the data from the data source
        try {
            const source = this.config.dataSource;

            if (source.fetchByIds) {
                const entityFragments = await source.fetchByIds(name, ids, days, fields);
                fetchedFragments.push(...entityFragments);
            } else {
                const entityFragments = await source.fetch(name, days, fields);
                const filtered = entityFragments.filter(p => p.id && ids.includes(p.id) && p.name === name);
                fetchedFragments.push(...filtered);
            }
        } catch (err) {
            this.logger.logError(`${CacheErrorMessage.POLLING_ERROR} ${name}`, err);
            return;
        }

        // entity name -> id -> entity fields
        const mergedMap = this.processFetchedFragments(fetchedFragments, days);

        for (const [pName, entities] of mergedMap.entries()) {
            for (const completeEntity of entities) {
                const cacheItem = this.getExistingCacheItem(pName, completeEntity.id, days);

                if (cacheItem) {
                    if (completeEntity.version && completeEntity.version > cacheItem.data.version) {
                        mergeChanges(cacheItem.data, completeEntity, (removedTypename, removedId) => {
                            this.logger.logRelationDisposal(removedTypename, removedId);
                            if (cacheItem.activeGroups) {
                                for (const group of cacheItem.activeGroups.keys()) {
                                    this.release(removedTypename, days, group, undefined, [removedId]);
                                }
                            }
                        });
                        this.logger.logPollingUpdate(`${pName}:${completeEntity.id}`, completeEntity.version, days);
                        this.onEntityUpdated.next(cacheItem.data);
                    }
                } else {
                    // Newly discovered entity ID fragment from a parent's relational array!
                    // Store it so the upcoming lightweight child poll actively picks it up.
                    this.storeInCache(completeEntity, pName, completeEntity.id, days);
                    this.logger.logPollingUpdate(`NEW ${pName}:${completeEntity.id}`, completeEntity.version, days);
                    this.onEntityUpdated.next(completeEntity);
                }
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

                    if (!this.isInsideConfigRange(entityDays, this.config.pollingTimeRange)) {
                        if (cacheItem.activeGroups.size === 0) {
                            this.startTtlCountdown(cacheItem, name, id, entityDays);
                        }
                    }
                }
            }
        }
    }

    // ============== AGGREGATION & POLLING ============== //

    private async aggregateFromSources(entityName: string, days?: string[], dataGroup?: string, fields?: string[], subscriberFilters?: Record<string, any>): Promise<T[]> {
        const start = Date.now();
        const allFragments: Partial<T>[] = [];

        try {
            const entityFragments = await this.config.dataSource.fetch(entityName, days, fields, subscriberFilters);
            allFragments.push(...entityFragments);
        } catch (err) {
            this.logger.logError(`Aggregation fetch error for ${entityName}`, err);
        }

        const mergedMap = this.processFetchedFragments(allFragments, days);
        const primaryEntities = mergedMap.get(entityName) || [];

        for (const [name, entities] of mergedMap.entries()) {
            for (const entity of entities) {
                const existing = this.getExistingCacheItem(name, entity.id, days);
                if (existing) {
                    mergeChanges(existing.data, entity);
                } else {
                    this.storeInCache(entity, name, entity.id, days);
                }
            }
        }

        this.logger.logAggregationComplete(entityName, Date.now() - start, days);

        if (this.config.relations && this.config.relations[entityName] && primaryEntities.length > 0) {
            const relatedNames = this.config.relations[entityName];
            const entityIds = primaryEntities.map(e => e.id);

            this.fetchAndStoreAssociatedEntities(relatedNames, entityIds, days, dataGroup).catch(err => {
                this.logger.logError('Associated Entities Fetch Error', err);
            });
        }

        return primaryEntities;
    }

    private async fetchAndStoreAssociatedEntities(relatedNames: string[], ids: string[], days?: string[], dataGroup?: string): Promise<void> {
        for (const relatedName of relatedNames) {
            const entityMap = new Map<string, Partial<T>>();
            const source = this.config.dataSource;

            if (source.fetchByIds) {
                try {
                    const entityFragments = await source.fetchByIds(relatedName, ids, days);

                    for (const fragment of entityFragments) {
                        if (fragment?.id) {
                            entityMap.set(fragment.id, fragment);
                        }
                    }
                } catch (err) {
                    this.logger.logError(`Assoc Fetch error for ${relatedName}`, err);
                }
            } else {
                try {
                    const entityFragments = await source.fetch(relatedName, days);
                    for (const fragment of entityFragments) {
                        if (fragment && fragment.id && ids.includes(fragment.id) && fragment.name === relatedName) {
                            entityMap.set(fragment.id, fragment);
                        }
                    }
                } catch (err) {
                    this.logger.logError(`Assoc Fetch fallback error for ${relatedName}`, err);
                }
            }

            for (const [id, fragment] of entityMap.entries()) {
                // deepMerge is commented out as entities from the unified GraphQL schema are no longer fragmented across multiple sources
                // const completeEntity = deepMerge<T>(...fragmentChunks);
                const completeEntity = fragment as T;

                this.ensureEntityContract(completeEntity, relatedName, id, days);

                const existing = this.getExistingCacheItem(relatedName, id, days);
                if (existing) {
                    mergeChanges(existing.data, completeEntity as T);
                    if (dataGroup) {
                        const group = existing.activeGroups.get(dataGroup);
                        if (group) group.refCount += 1;
                        else existing.activeGroups.set(dataGroup, { fields: [], refCount: 1 });
                    }
                } else {
                    this.storeInCache(completeEntity as T, relatedName, id, days);
                    if (dataGroup) {
                        const newItem = this.getExistingCacheItem(relatedName, id, days);
                        if (newItem) newItem.activeGroups.set(dataGroup, { fields: [], refCount: 1 });
                    }
                }
            }

            const aggregationKey = this.getAggregationKey(relatedName, days);
            this.fullyLoadedKeys.add(aggregationKey);
        }
    }

    private processFetchedFragments(fragments: Partial<T>[], days?: string[]): Map<string, T[]> {
        const entityMapByName = new Map<string, Map<string, Partial<T>>>();

        // looping over all fragments and grouping them by name and id
        for (const fragment of fragments) {
            if (fragment?.id && fragment?.name) {
                let idMap: Map<string, Partial<T>> | undefined = entityMapByName.get(fragment.name);

                if (!idMap) {
                    idMap = new Map();
                    entityMapByName.set(fragment.name, idMap);
                }

                idMap.set(fragment.id, fragment);
            }
        }

        const completelyMerged = new Map<string, T[]>();

        for (const [name, idMap] of entityMapByName.entries()) {
            const mergedList: T[] = [];

            for (const [id, fragment] of idMap.entries()) {
                // deepMerge is commented out as entities from the unified GraphQL schema are no longer fragmented across multiple sources
                // const completeEntity = deepMerge<T>(...fragmentChunks);
                const completeEntity = fragment as T;

                this.ensureEntityContract(completeEntity, name, id, days);

                mergedList.push(completeEntity);
            }
            completelyMerged.set(name, mergedList);
        }

        return completelyMerged;
    }

    private registerRootSubscription(entityName: string, aggregationKey: string, days?: string[], dataGroup?: string, subscriberFilters?: Record<string, any>): void {
        if (!dataGroup) return;

        let sub = this.activeRootSubscriptions.get(aggregationKey);
        if (!sub) {
            sub = {
                entityName,
                days,
                dataGroups: new Map<string, number>(),
                subscriberFilters,
                lastDiscoveryTime: Date.now() // Initialize with current time so it doesn't fire immediately
            };
            this.activeRootSubscriptions.set(aggregationKey, sub);
        }

        const currentCount = sub.dataGroups.get(dataGroup) || 0;
        sub.dataGroups.set(dataGroup, currentCount + 1);
    }

    private deregisterRootSubscription(aggregationKey: string, dataGroup: string): void {
        const sub = this.activeRootSubscriptions.get(aggregationKey);
        if (sub) {
            const count = sub.dataGroups.get(dataGroup) || 0;
            if (count <= 1) {
                sub.dataGroups.delete(dataGroup);
            } else {
                sub.dataGroups.set(dataGroup, count - 1);
            }

            if (sub.dataGroups.size === 0) {
                this.activeRootSubscriptions.delete(aggregationKey);
            }
        }
    }

    private extractChildIds(data: T, childType: string): string[] {
        const ids: string[] = [];
        const stack: any[] = [data];
        const visited = new Set<any>();

        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || typeof current !== 'object' || visited.has(current)) continue;
            visited.add(current);

            if (current.__typename === childType && current.id) {
                ids.push(current.id);
            }

            for (const value of Object.values(current)) {
                if (Array.isArray(value)) {
                    stack.push(...value);
                } else if (value && typeof value === 'object') {
                    stack.push(value);
                }
            }
        }
        return [...new Set(ids)];
    }
}
