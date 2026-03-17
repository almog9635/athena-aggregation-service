export interface CacheItem<T> {
    data: T;
    // Maps a unique subscriber/DataGroup ID to the fields they require for this cache item and the refCount
    activeGroups: Map<string, { fields: string[], refCount: number }>;
    ttlTimeout: NodeJS.Timeout | null;
}