export interface CacheItem<T> {
    data: T;
    refCount: number;
    ttlTimeout: NodeJS.Timeout | null;
}