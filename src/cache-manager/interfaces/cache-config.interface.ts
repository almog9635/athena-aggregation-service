import { IDataSource } from './datasource.interface';
import { IEntity } from './entity.interface';

export interface DataGroupConfig {
    entityName: string;
    fields: string[];
    uncachedFields?: string[];
    /** Specific time range for entities in this DataGroup. */
    defaultTimeRange: TimeRangeConfig;
}

export interface TimeRangeConfig {
    /** Number of days in the past to keep in memory. e.g., 7 for a week */
    pastDays: number;
    /** Number of days in the future to keep in memory. */
    futureDays: number;
}

export interface CacheConfig<T extends IEntity> {
    /** 
     * The underlying loop execution speed. Lower values increase precision for fast entities at the cost of CPU. 
     * @default 5000 
     */
    baseTickMs?: number;

    /** Time-to-live in milliseconds for entities that drop to 0 active fields. */
    ttlMs: number;

    /** Global default interval in milliseconds for the background polling cycle. */
    pollingIntervalMs: number;

    /** Global default interval in milliseconds for the background discovery cycle. */
    discoveryIntervalMs?: number;

    /** Entity-specific overrides. */
    entitySettings?: Record<string, { 
        pollingIntervalMs?: number;
        discoveryIntervalMs?: number;
    }>;

    /** Configuration for the persistence time window for Time-Dependent entities that are actively polled. */
    pollingTimeRange?: TimeRangeConfig;

    /** Configuration for the time window that can be fetched on demand but is NOT actively polled. */
    onDemandTimeRange?: TimeRangeConfig;

    /** Relation map for auto-fetching associated entities (e.g. { "User": ["UserStats"] }) */
    relations?: Record<string, string[]>;

    /** Mapping of DataGroup names to the entities and fields they require. */
    dataGroupMapping?: Record<string, DataGroupConfig[]>;

    /** The primary unified data source to query for entities. */
    dataSource: IDataSource<T>;
}
