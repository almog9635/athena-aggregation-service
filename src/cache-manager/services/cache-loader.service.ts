import { Injectable, Inject } from '@nestjs/common';
import { Subject } from 'rxjs';
import { CacheStore } from '../store/cache-store';
import { CacheGroupManager } from './cache-group.service';
import type { CacheConfig } from '../interfaces/cache-config.interface';
import { DefaultCacheLogger, type ICacheLogger } from '../logger/cache-logger.service';
import type { IEntity } from '../interfaces/entity.interface';
import { mergeChanges } from '../utils/merge.util';
import { getConfiguredDays } from '../utils/time.util';
import { ensureEntityContract, processFetchedFragments } from '../utils/entity.util';

@Injectable()
export class CacheLoaderService<T extends IEntity> {
    public readonly onRelationDisposed = new Subject<{ typeName: string, id: string, days?: string[] }>();

    constructor(
        private readonly cacheStore: CacheStore<T>,
        private readonly cacheGroupManager: CacheGroupManager,
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
        @Inject('CACHE_LOGGER') private readonly logger: ICacheLogger = new DefaultCacheLogger(),
    ) { }

    public async preloadConfiguredDays() {
        if (!this.config.pollingTimeRange) {
            return;
        }

        const days = getConfiguredDays(this.config.pollingTimeRange);

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
                const completeEntity = fragment as T;

                ensureEntityContract(completeEntity, name, id, days);

                const existing = this.cacheStore.getItem(name, id, days ? days[0] : undefined);

                if (existing) {
                    mergeChanges(existing.data, completeEntity, (removedTypename, removedId) => {
                        this.logger.logRelationDisposal(removedTypename, removedId);
                        this.onRelationDisposed.next({ typeName: removedTypename, id: removedId, days });
                    });
                } else {
                    this.cacheStore.storeInCache(completeEntity, name, id, days);
                }
            }

            const queryKey = this.cacheGroupManager.getQueryKey(name, days);
            this.cacheStore.fullyLoadedKeys.add(queryKey);
        }

        this.logger.logAggregationComplete(`PRELOAD_CURRENT_WEEK`, Date.now() - start, days);
    }

    public async aggregateFromSources(entityName: string, days?: string[], dataGroup?: string, fields?: string[], subscriberFilters?: Record<string, any>): Promise<T[]> {
        const start = Date.now();
        const allFragments: Partial<T>[] = [];

        try {
            const entityFragments = await this.config.dataSource.fetch(entityName, days, fields, subscriberFilters);
            allFragments.push(...entityFragments);
        } catch (err) {
            this.logger.logError(`Aggregation fetch error for ${entityName}`, err);
        }

        const mergedMap = processFetchedFragments<T>(allFragments, days);
        const primaryEntities = mergedMap.get(entityName) || [];

        for (const [name, entities] of mergedMap.entries()) {
            for (const entity of entities) {
                const existing = this.cacheStore.getExistingCacheItem(name, entity.id, days);

                if (existing) {
                    mergeChanges(existing.data, entity);
                } else {
                    this.cacheStore.storeInCache(entity, name, entity.id, days);
                }
            }
        }

        this.logger.logAggregationComplete(entityName, Date.now() - start, days);

        if (this.config.relations?.[entityName] && primaryEntities.length > 0) {
            const relatedNames = this.config.relations[entityName];
            const entityIds = primaryEntities.map(e => e.id);

            const assocCount = await this.fetchAndStoreAssociatedEntities(relatedNames, entityIds, days, dataGroup);
            this.logger.logAssociationHydration(entityName, assocCount);
        }

        return primaryEntities;
    }

    private async fetchAndStoreAssociatedEntities(relatedNames: string[], ids: string[], days?: string[], dataGroup?: string): Promise<number> {
        let totalProcessed = 0;
        for (const relatedName of relatedNames) {
            const entityMap = await this.fetchAssociatedFragments(relatedName, ids, days);

            for (const [id, fragment] of entityMap.entries()) {
                const isNew = this.processAssociatedEntity(relatedName, id, fragment, days, dataGroup);

                if (isNew) {
                    totalProcessed++;
                }
            }

            const queryKey = this.cacheGroupManager.getQueryKey(relatedName, days);
            this.cacheStore.fullyLoadedKeys.add(queryKey);
        }
        return totalProcessed;
    }

    private processAssociatedEntity(name: string, id: string, fragment: Partial<T>, days?: string[], dataGroup?: string): boolean {
        const completeEntity = fragment as T;
        ensureEntityContract(completeEntity, name, id, days);
        const existing = this.cacheStore.getExistingCacheItem(name, id, days);

        if (existing) {
            mergeChanges(existing.data, completeEntity);

            if (dataGroup) {
                this.cacheGroupManager.incrementGroupCount(existing, dataGroup);
            }

            return false;
        }

        this.cacheStore.storeInCache(completeEntity, name, id, days);

        if (dataGroup) {
            const newItem = this.cacheStore.getExistingCacheItem(name, id, days);
            if (newItem) this.cacheGroupManager.incrementGroupCount(newItem, dataGroup);
        }

        return true;
    }

    private async fetchAssociatedFragments(relatedName: string, ids: string[], days?: string[]): Promise<Map<string, Partial<T>>> {
        const entityMap = new Map<string, Partial<T>>();
        const source = this.config.dataSource;

        try {
            if (source.fetchByIds) {
                const entityFragments = await source.fetchByIds(relatedName, ids, days);
                entityFragments.forEach(fragment => {
                    if (fragment?.id) entityMap.set(fragment.id, fragment);
                });
            } else {
                const entityFragments = await source.fetch(relatedName, days);
                entityFragments.forEach(fragment => {
                    if (fragment?.id && ids.includes(fragment.id) && fragment.name === relatedName) {
                        entityMap.set(fragment.id, fragment);
                    }
                });
            }
        } catch (err) {
            this.logger.logError(`Assoc Fetch error for ${relatedName}`, err);
        }

        return entityMap;
    }
}
