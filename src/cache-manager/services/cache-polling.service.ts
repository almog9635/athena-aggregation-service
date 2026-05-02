import { Injectable, Inject, OnModuleDestroy, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { CacheStore } from '../store/cache-store';
import { CacheGroupManager } from './cache-group.service';
import type { CacheConfig } from '../interfaces/cache-config.interface';
import { CacheItem } from '../interfaces/cache-item';
import type { IEntity, ITimeDependentEntity } from '../interfaces/entity.interface';
import { CacheErrorMessage } from '../enums/error-message.enum';
import { processFetchedFragments } from '../utils/entity.util';
import { mergeChanges } from '../utils/merge.util';
import { getUnionOfConfiguredDays, isInsideConfigRange } from '../utils/time.util';
import { CacheLoaderService } from './cache-loader.service';

@Injectable()
export class CachePollingService<T extends IEntity> implements OnModuleDestroy {

    public readonly onEntityUpdated = new Subject<T>();
    public readonly onRelationDisposed = new Subject<{ typeName: string, id: string, days?: string[] }>();

    private readonly lastPollTimes = new Map<string, number>();
    private pollingIntervalId: NodeJS.Timeout | null = null;
    private rolloverIntervalId: NodeJS.Timeout | null = null;

    private readonly logger = new Logger('CacheManager');

    constructor(
        private readonly cacheStore: CacheStore<T>,
        private readonly cacheGroupManager: CacheGroupManager,
        private readonly cacheLoaderService: CacheLoaderService<T>,
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
    ) { }

    onModuleDestroy() {
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
        }

        if (this.rolloverIntervalId) {
            clearInterval(this.rolloverIntervalId);
        }
    }

    public startBackgroundTasks() {
        if (this.config.pollingIntervalMs > 0 ||
            (this.config.entitySettings && Object.keys(this.config.entitySettings).length > 0)) {
            const tickRate = this.config.baseTickMs && this.config.baseTickMs > 0 ? this.config.baseTickMs : 5000;
            this.pollingIntervalId = setInterval(() => this.pollTick(), tickRate);
        }

        this.scheduleMidnightRollover();
    }

    private scheduleMidnightRollover() {
        if (this.rolloverIntervalId) {
            clearTimeout(this.rolloverIntervalId);
            this.rolloverIntervalId = null;
        }

        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0); // Next midnight
        const msUntilMidnight = midnight.getTime() - now.getTime();

        this.logger.log(`[UPDATE] Scheduling Midnight Rollover in ${Math.round(msUntilMidnight / 1000 / 60)} minutes polled new version: 0. Modified fields merged.`);

        this.rolloverIntervalId = setTimeout(() => {
            this.executeRollover();
            // Then schedule the next one exactly 24 hours later
            this.rolloverIntervalId = setInterval(() => this.executeRollover(), 1000 * 60 * 60 * 24);
        }, msUntilMidnight) as unknown as NodeJS.Timeout;
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
        for (const sub of this.cacheGroupManager.getActiveRootSubscriptions().values()) {
            const lastDiscovery = sub.lastDiscoveryTime || 0;
            const discoveryInterval = this.getDiscoveryInterval(sub.entityName);

            if (now - lastDiscovery >= discoveryInterval) {
                sub.lastDiscoveryTime = now;
                // We pick one dataGroup from the set to use as the "primary" trigger for field inheritance
                const dataGroup = sub.dataGroups.keys().next().value;

                await this.cacheLoaderService.aggregateFromSources(sub.entityName, sub.days, dataGroup, undefined, sub.subscriberFilters).catch(err => {
                    this.logger.error(`[ERROR] Discovery error for ${sub.entityName}`, err instanceof Error ? err.stack : err);
                });
            }
        }

        const activeEntities = new Set<string>(this.cacheStore.getAllEntityNames());

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

        const entities = this.cacheStore.getAllEntities(name);
        if (entities.length === 0) return;

        // Note: For an entity with time dependency, we need to extract IDs by days.
        const processedIds = new Set<string>();
        const idsParams = new Map<string, { ids: string[], days: string[], fields: string[] }>();
        this.pollIndependentEntries(name);

        entities.forEach(data => {
            const id = data.id;
            const days = (data as any).days;
            const existingCacheItem = this.cacheStore.getExistingCacheItem(name, id, days);

            if (existingCacheItem && !existingCacheItem.ttlTimeout && !processedIds.has(id)) {
                if (days && days.length > 0) {
                    processedIds.add(id);

                    const uniqueFields = this.getUnifiedFields(existingCacheItem);

                    const entityDays = (existingCacheItem.data as unknown as ITimeDependentEntity).days;
                    const shouldPoll = this.shouldPollItem(existingCacheItem, entityDays);

                    if (shouldPoll) {
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
            }
        });

        for (const params of idsParams.values()) {
            if (params.ids.length > 0) {
                await this.executePollFetch(name, params.ids, params.days, params.fields.length > 0 ? params.fields : undefined);
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
            this.logger.error(`[ERROR] ${CacheErrorMessage.POLLING_ERROR} ${name}`, err instanceof Error ? err.stack : err);
            return;
        }

        // entity name -> id -> entity fields
        const mergedMap = processFetchedFragments(fetchedFragments, days);

        for (const [pName, entities] of mergedMap.entries()) {
            for (const completeEntity of entities) {
                const cacheItem = this.cacheStore.getExistingCacheItem(pName, completeEntity.id, days);

                if (cacheItem) {
                    if (completeEntity.version && completeEntity.version > cacheItem.data.version) {
                        const originalDays = (cacheItem.data as unknown as ITimeDependentEntity).days;
                        const originalDaysStr = originalDays ? JSON.stringify([...originalDays].sort()) : undefined;

                        mergeChanges(cacheItem.data, completeEntity, (removedTypename, removedId) => {
                            this.logger.log(`[RELATION DISPOSAL] Removing orphaned ${removedTypename}:${removedId} from active tracking.`);
                            this.onRelationDisposed.next({ typeName: removedTypename, id: removedId, days });
                        });

                        const newDays = (cacheItem.data as unknown as ITimeDependentEntity).days;
                        const newDaysStr = newDays ? JSON.stringify([...newDays].sort()) : undefined;

                        if (originalDays && newDays && originalDaysStr !== newDaysStr) {
                            this.cacheStore.reindex(cacheItem, pName, completeEntity.id, originalDays, newDays);
                        }

                        const daysLabel1 = days && days.length > 0 ? ` [Days: ${days.join(',')}]` : '';
                        this.logger.log(`[UPDATE] ${pName}:${completeEntity.id}${daysLabel1} polled new version: ${completeEntity.version}. Modified fields merged.`);
                        this.onEntityUpdated.next(cacheItem.data);
                    }
                } else {
                    // Newly discovered entity ID fragment from a parent's relational array
                    // Store it so the upcoming lightweight child poll actively picks it up.
                    this.cacheStore.storeInCache(completeEntity, pName, completeEntity.id, days);
                    const daysLabel2 = days && days.length > 0 ? ` [Days: ${days.join(',')}]` : '';
                    this.logger.log(`[UPDATE] NEW ${pName}:${completeEntity.id}${daysLabel2} polled new version: ${completeEntity.version}. Modified fields merged.`);
                    this.onEntityUpdated.next(completeEntity);
                }
            }
        }
    }

    private async executeRollover() {
        this.logger.log(`[UPDATE] Starting midnight rollover session polled new version: 0. Modified fields merged.`);

        // 1. Determine all active days across all configurations
        const activeDaysList = this.getActiveDays();
        const activeDays = new Set(activeDaysList);

        // 2. Remove stale day buckets in CacheStore
        this.cacheStore.removeOutOfRangeDays(activeDaysList);

        // 3. TTL Countdown for entities that are now out of any active range but might still be referenced
        const names = this.cacheStore.getAllEntityNames();

        names.forEach(name => {
            this.cacheStore.getAllEntities(name)
                .filter(item => {
                    const entityDays = (item as unknown as ITimeDependentEntity).days;
                    // If any of the entity days are still in the active window, we keep it
                    const stillRelevant = entityDays?.some(d => activeDays.has(d));
                    return !stillRelevant;
                })
                .forEach(item => {
                    const entityDays = (item as unknown as ITimeDependentEntity).days;
                    const cacheItem = this.cacheStore.getExistingCacheItem(name, item.id, entityDays);

                    if (cacheItem?.activeGroups.size === 0) {
                        this.cacheStore.startTtlCountdown(cacheItem, name, item.id, entityDays, this.cacheGroupManager);
                    }
                });
        });

        // 4. Force a preload to catch the 'new' day that just entered the window
        await this.cacheLoaderService.preloadConfiguredDays();

        const activeDaysLabel = activeDaysList.length > 0 ? ` [Days: ${activeDaysList.join(',')}]` : '';
        this.logger.log(`[UPDATE] Midnight rollover completed${activeDaysLabel} polled new version: 0. Modified fields merged.`);
    }

    public getActiveDays(): string[] {
        return getUnionOfConfiguredDays(this.config);
    }

    private getUnifiedFields(item: CacheItem<T>): string[] {
        const unified = Array.from(item.activeGroups.values()).flatMap(group => group.fields);
        return [...new Set(unified)];
    }

    private async pollIndependentEntries(name: string): Promise<void> {
        const indepMap = this.cacheStore.getMap(name);
        if (!indepMap || indepMap.size === 0) return;

        const idsToUpdate: string[] = [];
        indepMap.forEach((item, id) => {
            if (!item.ttlTimeout) idsToUpdate.push(id);
        });

        if (idsToUpdate.length > 0) {
            await this.executePollFetch(name, idsToUpdate);
        }
    }

    private shouldPollItem(item: CacheItem<T>, entityDays?: string[]): boolean {
        if (!entityDays || entityDays.length === 0) {
            return true;
        }

        const isPolling = isInsideConfigRange(entityDays, this.config.pollingTimeRange);
        if (isPolling) {
            return true;
        }

        const isOnDemand = this.config.onDemandTimeRange ? isInsideConfigRange(entityDays, this.config.onDemandTimeRange) : false;
        return isOnDemand && item.activeGroups.size > 0;
    }

}
