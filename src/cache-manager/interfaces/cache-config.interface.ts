import { IDataSource } from './datasource.interface';
import { IEntity } from './entity.interface';

export interface TimeRangeConfig {
    /** Number of days in the past to keep permanently in memory (polling range). e.g., 7 for a week */
    pastDays: number;
    /** Number of days in the future to keep permanently in memory. */
    futureDays: number;
}

export interface CacheConfig<T extends IEntity> {
    /** Time-to-live in milliseconds for entities that drop to 0 refCount. */
    ttlMs: number;

    /** Interval in milliseconds for the background polling cycle. */
    pollingIntervalMs: number;

    /** Configuration for the persistence time window for Time-Dependent entities. */
    timeRange?: TimeRangeConfig;

    /** Relation map for auto-fetching associated entities (e.g. { "User": ["UserStats"] }) */
    relations?: Record<string, string[]>;

    /** The primary and enrichment data sources to query for slices of the entity. */
    dataSources: IDataSource<T>[];
}
