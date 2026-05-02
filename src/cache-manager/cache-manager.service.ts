import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject, Subscription } from 'rxjs';
import type { CacheConfig } from './interfaces/cache-config.interface';
import type { IEntity } from './interfaces/entity.interface';
import { CacheErrorMessage } from './enums/error-message.enum';
import { CacheStore } from './store/cache-store';
import { CacheGroupManager } from './services/cache-group.service';
import { CachePollingService } from './services/cache-polling.service';
import { CacheLoaderService } from './services/cache-loader.service';
import { CacheItem } from './interfaces/cache-item';
import { isInsideConfigRange } from './utils/time.util';

@Injectable()
export class CacheManager<T extends IEntity> implements OnModuleInit, OnModuleDestroy {

    public readonly onEntityUpdated = new Subject<T>();
    private relationDisposableSub: Subscription | null = null;
    private entityUpdateSub: Subscription | null = null;

    // Tracks items that are actively being aggregated (to prevent concurrent identical fetches)
    private readonly pendingAggregations = new Map<string, Promise<T[]>>();

    constructor(
        private readonly cacheStore: CacheStore<T>,
        private readonly cacheGroupManager: CacheGroupManager,
        private readonly cachePollingService: CachePollingService<T>,
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
        private readonly cacheLoaderService: CacheLoaderService<T>,
    ) { }

    private readonly logger = new Logger('CacheManager');

    async onModuleInit() {
        this.cachePollingService.startBackgroundTasks();

        // Listen for updates from Polling
        this.entityUpdateSub = this.cachePollingService.onEntityUpdated.subscribe(entity => {
            this.onEntityUpdated.next(entity);
        });

        // Listen for relations being removed during polling/merging so we can trigger a targeted recursive release.
        this.relationDisposableSub = this.cachePollingService.onRelationDisposed.subscribe(({ typeName, id, days }) => {
            const cacheItem = this.cacheStore.getExistingCacheItem(typeName, id, days);

            if (cacheItem?.activeGroups) {
                for (const group of cacheItem.activeGroups.keys()) {
                    this.release(typeName, days, group, undefined, [id]);
                }
            }
        });

        await this.cacheLoaderService.preloadConfiguredDays();
        this.cachePollingService.startBackgroundTasks();
    }

    onModuleDestroy() {
        if (this.entityUpdateSub) {
            this.entityUpdateSub.unsubscribe();
        }

        if (this.relationDisposableSub) {
            this.relationDisposableSub.unsubscribe();
        }

        this.cachePollingService.onModuleDestroy();
        this.cacheStore.clearAllTtls();
    }

    /**
     * Acquires all entities of a specific name from the cache.
     * If they haven't been fetched yet, aggregates them from sources.
     */
    async acquire(entityName: string, days?: string[], dataGroup?: string,
        requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<T[]> {
        const queryKey = this.cacheGroupManager.getQueryKey(entityName, days, subscriberFilters);

        if (this.cacheStore.fullyLoadedKeys.has(queryKey)) {
            const resultsMap = new Map<string, T>();
            const dayList = (days && days.length > 0) ? days : [undefined];
            let isUnderFetched = false;

            for (const day of dayList) {
                const entityNameMap = day ? this.cacheStore.getMapForDay(entityName, day) : this.cacheStore.getMap(entityName);

                if (entityNameMap) {
                    for (const item of entityNameMap.values()) {
                        if (dataGroup) {
                            this.cacheGroupManager.incrementGroupCount(item, dataGroup, requestedFields);
                        }

                        this.cacheGroupManager.registerRootSubscription(entityName, queryKey, days, dataGroup, subscriberFilters);
                        this.cacheStore.cancelTtl(item, entityName, item.data.id, days);
                        resultsMap.set(item.data.id, item.data);
                    }
                }
            }

            // Detect Under-fetching
            if (requestedFields?.length) {
                isUnderFetched = this.checkUnderFetching(entityName, days, requestedFields, resultsMap);
            }

            if (isUnderFetched) {
                this.logger.debug(`[MISS] ${entityName} (Under-fetched fields)${days && days.length > 0 ? ` [Days: ${days.join(',')}]` : ''}`);
                // Deliberately drop the fully loaded key to force a re-aggregation that includes the missing fields.
                this.cacheStore.fullyLoadedKeys.delete(queryKey);
            } else {
                // If we have a hit, we still need to register the root subscription for discovery
                this.cacheGroupManager.registerRootSubscription(entityName, queryKey, days, dataGroup, subscriberFilters);
                this.logger.debug(`[HIT] ${entityName}${days && days.length > 0 ? ` [Days: ${days.join(',')}]` : ''}`);

                return Array.from(resultsMap.values());
            }
        } else {
            this.logger.debug(`[MISS] ${entityName}${days && days.length > 0 ? ` [Days: ${days.join(',')}]` : ''}`);
            this.cacheGroupManager.registerRootSubscription(entityName, queryKey, days, dataGroup, subscriberFilters);
        }

        let pendingPromise = this.pendingAggregations.get(queryKey);

        if (!pendingPromise) {
            pendingPromise = this.cacheLoaderService.aggregateFromSources(entityName, days, dataGroup, requestedFields, subscriberFilters);
            this.pendingAggregations.set(queryKey, pendingPromise);

            pendingPromise.finally(() => {
                this.pendingAggregations.delete(queryKey);
            });
        }

        // It's a Miss. Wait for aggregation...
        const primaryEntities = await pendingPromise;

        for (const entity of primaryEntities) {
            const cacheItem = this.cacheStore.getExistingCacheItem(entityName, entity.id, days);

            if (cacheItem && dataGroup) {
                if (!cacheItem.activeGroups.has(dataGroup)) {
                    this.cacheGroupManager.incrementGroupCount(cacheItem, dataGroup, requestedFields);
                }
            }
        }

        this.cacheStore.fullyLoadedKeys.add(queryKey);

        return primaryEntities;
    }



    /**
     * Releases a reference to an entity.
     * type for a specific dataGroup. If nobody is active, it may be scheduled for eviction.
     * Use filters to ensure you only release entities belonging to the disconnecting user.
     * Use specificIds to strictly target entities for explicit disposal (e.g. Relation Disposal).
     */
    release(entityName: string, days?: string[], dataGroup?: string, subscriberFilters?: Record<string, any>, specificIds?: string[], visitedIds?: Set<string>): void {
        const resultsMap = new Map<string, CacheItem<T>>();
        const dayList = (days && days.length > 0) ? days : [undefined];

        // check what happens for undefined days
        for (const day of dayList) {
            const nameMap = day ? this.cacheStore.getMapForDay(entityName, day) : this.cacheStore.getMap(entityName);

            if (nameMap) {
                for (const item of nameMap.values()) {
                    resultsMap.set(item.data.id, item);
                }
            }
        }

        // 1. Cleanup root tracking if this is a root release
        if (dataGroup && !specificIds && !visitedIds) {
            const queryKey = this.cacheGroupManager.getQueryKey(entityName, days, subscriberFilters);
            this.cacheGroupManager.deregisterRootSubscription(queryKey, dataGroup);
        }

        const visited = visitedIds || new Set<string>();

        if (resultsMap.size === 0) {
            this.logger.error(`[ERROR] ${CacheErrorMessage.RELEASE_NON_EXISTENT}`, { name: entityName, days });
            return;
        }

        const isTimeDependent = days && days.length > 0;
        const isInsidePollingRange = isTimeDependent && this.config.pollingTimeRange && isInsideConfigRange(days, this.config.pollingTimeRange);

        const targetEntries = this.getMatchingEntries(resultsMap, specificIds, subscriberFilters);

        for (const [id, cacheItem] of targetEntries) {
            this.cacheGroupManager.decrementGroupCount(cacheItem, dataGroup);

            if (cacheItem.activeGroups.size === 0) {
                if (!isTimeDependent || !isInsidePollingRange) {
                    this.cacheStore.startTtlCountdown(cacheItem, entityName, id, days, this.cacheGroupManager);
                }
            }

            // 3. Recursive Release: Release children that were auto-fetched for this entity
            const childTypes = this.config.relations?.[entityName];
            if (childTypes) {
                childTypes.forEach((childType) => {
                    const childIds = this.cacheGroupManager.extractChildIds(cacheItem.data, childType);
                    if (childIds.length > 0) {
                        this.release(childType, days, dataGroup, undefined, childIds, visited);
                    }
                });
            }
        }
    }

    /**
     * Filters entries based on specific IDs or subscriber filter criteria.
     */
    private getMatchingEntries(
        resultsMap: Map<string, CacheItem<T>>,
        specificIds?: string[],
        subscriberFilters?: Record<string, any>,
    ): [string, CacheItem<T>][] {
        return Array.from(resultsMap.entries()).filter(([id, cacheItem]) => {
            if (specificIds?.length && !specificIds.includes(id)) {
                return false;
            }

            if (subscriberFilters) {
                return Object.entries(subscriberFilters).every(([key, value]) => {
                    const itemValue = (cacheItem.data as any)[key];
                    return itemValue === value || (Array.isArray(value) && value.includes(itemValue));
                });
            }

            return true;
        });
    }

    /**
     * Checks if any of the cached entities are missing fields that were requested by the client.
     */
    private checkUnderFetching(entityName: string, days: string[] | undefined, requestedFields: string[], resultsMap: Map<string, T>): boolean {
        return Array.from(resultsMap.values()).some((item) => {
            const cachedItem = this.cacheStore.getExistingCacheItem(entityName, item.id, days);

            if (!cachedItem) {
                return false;
            }

            const allCachedFields = new Set<string>();

            for (const group of cachedItem.activeGroups.values()) {
                group.fields.forEach((f) => allCachedFields.add(f));
            }

            return requestedFields.some((field) => !allCachedFields.has(field));
        });
    }

    // this function should be in another class that will handle the fetching of uncached fields
    // but because there is already a connection to the cacheLoaderService,
    // I put it here instead of making a new one just for one function   
    public async fetchUncachedFields(
        entityName: string,
        ids: string[],
        fields: string[],
        days?: string[],
        subscriberFilters?: Record<string, any>
    ): Promise<Partial<T>[]> {
        if (!this.config.dataSource.fetchByIds) {
            this.logger.error(`[ERROR] fetchUncachedFields failed: dataSource.fetchByIds is not implemented for ${entityName}`, new Error().stack);
            return [];
        }

        try {
            return await this.config.dataSource.fetchByIds(entityName, ids, days, fields, subscriberFilters);
        } catch (err) {
            this.logger.error(`[ERROR] Failed to fetch uncached fields for ${entityName}`, err instanceof Error ? err.stack : err);
            return [];
        }
    }
}
