import { Injectable } from '@nestjs/common';
import { CacheItem } from '../interfaces/cache-item';

export interface RootSubscription {
    entityName: string;
    days?: string[];
    dataGroups: Map<string, number>; // dataGroupName -> refCount
    subscriberFilters?: Record<string, any>;
    lastDiscoveryTime: number;
}

@Injectable()
export class CacheGroupManager {

    /**
     * Discovery Map: Tracks which filters are currently being watched by users.
     * Maps queryKey -> filter metadata.
     * We use this to re-fetch root queries in the background to discover "newly created" entities.
     */
    private readonly activeRootSubscriptions = new Map<string, RootSubscription>();

    public getActiveRootSubscriptions(): Map<string, RootSubscription> {
        return this.activeRootSubscriptions;
    }

    public getQueryKey(entityName: string, days?: string[], subscriberFilters?: Record<string, any>): string {
        let key = days && days.length > 0 ? `${entityName}#${days.join('#')}` : entityName;

        if (subscriberFilters && Object.keys(subscriberFilters).length > 0) {
            // Hash the filters object to ensure isolation between different tenants/squadrons
            const filterHash = Buffer.from(JSON.stringify(subscriberFilters)).toString('base64');
            key += `#${filterHash}`;
        }

        return key;
    }

    public registerRootSubscription(entityName: string, queryKey: string,
        days?: string[], dataGroup?: string, subscriberFilters?: Record<string, any>): void {
        if (!dataGroup) {
            ``
            return;
        }

        let sub = this.activeRootSubscriptions.get(queryKey);

        if (!sub) {
            sub = {
                entityName,
                days,
                dataGroups: new Map<string, number>(),
                subscriberFilters,
                lastDiscoveryTime: Date.now() // Initialize with current time so it doesn't fire immediately
            };
            this.activeRootSubscriptions.set(queryKey, sub);
        }

        const currentCount = sub.dataGroups.get(dataGroup) || 0;
        sub.dataGroups.set(dataGroup, currentCount + 1);
    }

    public deregisterRootSubscription(queryKey: string, dataGroup: string): void {
        const sub = this.activeRootSubscriptions.get(queryKey);
        if (sub) {
            const count = sub.dataGroups.get(dataGroup) || 0;
            if (count <= 1) {
                sub.dataGroups.delete(dataGroup);
            } else {
                sub.dataGroups.set(dataGroup, count - 1);
            }

            if (sub.dataGroups.size === 0) {
                this.activeRootSubscriptions.delete(queryKey);
            }
        }
    }

    public incrementGroupCount<T>(item: CacheItem<T>, dataGroup: string, requestedFields?: string[]): void {
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

    public decrementGroupCount<T>(item: CacheItem<T>, dataGroup?: string): void {
        if (dataGroup) {
            const existing = item.activeGroups.get(dataGroup);
            if (existing) {
                existing.refCount -= 1;
                if (existing.refCount <= 0) {
                    item.activeGroups.delete(dataGroup);
                }
            }
        } else {
            item.activeGroups.clear();
        }
    }

    public extractChildIds<T>(data: T, childType: string): string[] {
        const ids: string[] = [];
        const stack: any[] = [data];
        const visited = new Set<any>();

        while (stack.length > 0) {
            const current = stack.pop();
            if (current && typeof current === 'object' && !visited.has(current)) {
                visited.add(current);

                if (current.__typename === childType && current.id) {
                    ids.push(current.id);
                }

                Object.values(current).forEach(value => {
                    if (Array.isArray(value)) {
                        stack.push(...value);
                    } else if (value && typeof value === 'object') {
                        stack.push(value);
                    }
                });
            }
        }
        return [...new Set(ids)];
    }
}
