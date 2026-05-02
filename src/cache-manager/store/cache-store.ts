import { Injectable, Inject, Logger } from '@nestjs/common';
import { IEntity } from '../interfaces/entity.interface';
import { CacheItem } from '../interfaces/cache-item';
import type { CacheConfig } from '../interfaces/cache-config.interface';

@Injectable()
export class CacheStore<T extends IEntity> {

    // Store Time-Independent items: Name -> ID -> CacheItem
    private readonly timeIndependentMap = new Map<string, Map<string, CacheItem<T>>>();

    // Store Time-Dependent items: Day -> Name -> ID -> CacheItem
    private readonly timeDependentMap = new Map<string, Map<string, Map<string, CacheItem<T>>>>();

    public readonly fullyLoadedKeys = new Set<string>();

    private readonly logger = new Logger('CacheManager');

    constructor(
        @Inject('CACHE_CONFIG') private readonly config: CacheConfig<T>,
    ) { }

    /**
     * Retrieves the specific inner map for an entity type and day.
     * Instantiates it cleanly if it doesn't exist.
     */
    public getMapForDay(entityName: string, day: string): Map<string, CacheItem<T>> {
        let dayMap = this.timeDependentMap.get(day);

        if (!dayMap) {
            dayMap = new Map<string, Map<string, CacheItem<T>>>();
            this.timeDependentMap.set(day, dayMap);
        }

        let entityMap = dayMap.get(entityName);

        if (!entityMap) {
            entityMap = new Map<string, CacheItem<T>>();
            dayMap.set(entityName, entityMap);
        }

        return entityMap;
    }

    /**
     * Retrieves the specific inner map for a time-independent entity type.
     * Instantiates it cleanly if it doesn't exist.
     */
    public getMap(entityName: string): Map<string, CacheItem<T>> {
        let entityMap = this.timeIndependentMap.get(entityName);
        if (!entityMap) {
            entityMap = new Map<string, CacheItem<T>>();
            this.timeIndependentMap.set(entityName, entityMap);
        }
        return entityMap;
    }

    /**
     * Gets a specific item from the store.
     */
    public getItem(entityName: string, id: string, day?: string): CacheItem<T> | undefined {
        if (day) {
            return this.timeDependentMap.get(day)?.get(entityName)?.get(id);
        }
        return this.timeIndependentMap.get(entityName)?.get(id);
    }

    /**
     * Gets all entities of a specific type (optionally filtered by day).
     */
    public getAllEntities(entityName: string, days?: string[]): T[] {
        const results: T[] = [];

        if (days && days.length > 0) {
            for (const day of days) {
                const dayMap = this.timeDependentMap.get(day);
                const entityMap = dayMap?.get(entityName);

                if (entityMap) {
                    for (const [, item] of entityMap) {
                        results.push(item.data);
                    }
                }
            }
        } else {
            // Get from time-independent map
            const indepMap = this.timeIndependentMap.get(entityName);
            if (indepMap) {
                for (const [, item] of indepMap) {
                    results.push(item.data);
                }
            }

            // Get from ALL time-dependent maps
            for (const dayMap of this.timeDependentMap.values()) {
                const depMap = dayMap.get(entityName);
                if (depMap) {
                    for (const [, item] of depMap) {
                        results.push(item.data);
                    }
                }
            }
        }

        // Deduplicate in case an entity exists across multiple days
        const uniqueResults = new Map<string, T>();
        for (const item of results) {
            uniqueResults.set(item.id, item);
        }
        return Array.from(uniqueResults.values());
    }

    public getAllEntityNames(): string[] {
        const names = new Set<string>();

        for (const name of this.timeIndependentMap.keys()) {
            names.add(name);
        }

        for (const dayMap of this.timeDependentMap.values()) {
            for (const name of dayMap.keys()) {
                names.add(name);
            }
        }

        return Array.from(names);
    }

    public getExistingCacheItem(entityName: string, id: string, days?: string[]): CacheItem<T> | undefined {
        const dayList = (days && days.length > 0) ? days : [undefined];

        for (const day of dayList) {
            let nameMap: Map<string, CacheItem<T>> | undefined;

            if (day) {
                nameMap = this.timeDependentMap.get(day)?.get(entityName);
            } else {
                nameMap = this.timeIndependentMap.get(entityName);
            }

            const item = nameMap?.get(id);

            if (item) {
                return item;
            }
        }

        return undefined;
    }

    public storeInCache(data: T, entityName: string, id: string, days?: string[]): void {
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

    /**
     * Re-indexes an existing item across different day buckets.
     * Removes the item from days it no longer belongs to, and adds it to new days.
     */
    public reindex(item: CacheItem<T>, entityName: string, id: string, oldDays: string[], newDays: string[]): void {
        const toRemove = oldDays.filter(day => !newDays.includes(day));
        const toAdd = newDays.filter(day => !oldDays.includes(day));

        // Remove from old days
        for (const day of toRemove) {
            const dayMap = this.timeDependentMap.get(day);
            if (dayMap) {
                const nameMap = dayMap.get(entityName);
                if (nameMap) {
                    nameMap.delete(id);
                    if (nameMap.size === 0) {
                        dayMap.delete(entityName);
                    }
                }
                if (dayMap.size === 0) {
                    this.timeDependentMap.delete(day);
                }
            }
        }

        // Add to new days
        for (const day of toAdd) {
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

            nameMap.set(id, item);
        }

        const daysLabel = newDays.length > 0 ? ` [Days: ${newDays.join(',')}]` : '';
        this.logger.log(`[UPDATE] Reindexed ${entityName}:${id}${daysLabel} polled new version: ${item.data.version}. Modified fields merged.`);
    }

    public cancelTtl(item: CacheItem<T>, entityName: string, id: string, days?: string[]) {
        if (item.ttlTimeout) {
            clearTimeout(item.ttlTimeout);
            item.ttlTimeout = null;
            const daysLabel = days && days.length > 0 ? ` [Days: ${days.join(',')}]` : '';
            this.logger.debug(`[TTL CANCELLED] ${entityName}:${id}${daysLabel} re-acquired.`);
        }
    }

    public startTtlCountdown(item: CacheItem<T>, entityName: string,
        id: string, days?: string[], cacheGroupManager?: any): void {
        if (item.ttlTimeout) {
            return;
        }

        const daysLabelTtl = days && days.length > 0 ? ` [Days: ${days.join(',')}]` : '';
        this.logger.debug(`[TTL START] ${entityName}:${id}${daysLabelTtl} refCount is 0. Evicting in ${this.config.ttlMs}ms.`);

        item.ttlTimeout = setTimeout(() => {
            this.evict(entityName, id, days, cacheGroupManager);
        }, this.config.ttlMs);
    }

    public evict(name: string, id: string, days?: string[], cacheGroupManager?: any): void {
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

        if (cacheGroupManager) {
            const queryKey = cacheGroupManager.getQueryKey(name, days);
            this.fullyLoadedKeys.delete(queryKey);
        }
        const daysLabelEvict = days && days.length > 0 ? ` [Days: ${days.join(',')}]` : '';
        this.logger.log(`[EVICTED] ${name}:${id}${daysLabelEvict} cleared from memory.`);
    }

    public clearAllTtls(): void {
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

    public countActiveGroups(item: CacheItem<T>): number {
        return Object.keys(item.activeGroups).length;
    }

    public removeDay(day: string): void {
        const dayMap = this.timeDependentMap.get(day);

        if (dayMap) {
            this.timeDependentMap.delete(day);
            this.logger.log(`[UPDATE] Removed day bucket: ${day} [Days: ${day}] polled new version: 0. Modified fields merged.`);
        }
    }

    public removeOutOfRangeDays(activeDays: string[]): void {
        const activeSet = new Set(activeDays);
        const allDays = Array.from(this.timeDependentMap.keys());

        for (const day of allDays) {
            if (!activeSet.has(day)) {
                this.removeDay(day);
            }
        }
    }

    public clearAll(): void {
        this.timeIndependentMap.clear();
        this.timeDependentMap.clear();
    }
}
