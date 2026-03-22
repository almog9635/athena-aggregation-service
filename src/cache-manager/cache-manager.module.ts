import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheManager } from './cache-manager.service';
import { CacheConfig, TimeRangeConfig } from './interfaces/cache-config.interface';
import { IDataSource } from './interfaces/datasource.interface';
import { IEntity } from './interfaces/entity.interface';
import { GraphQLStitchingModule } from '../graphql/graphql-stitching.module';
import { GraphQLDataSource } from './graphql-data-source';
import { CacheStore } from './store/cache-store';
import { CacheGroupManager } from './services/cache-group.service';
import { CachePollingService } from './services/cache-polling.service';
import { CacheLoaderService } from './services/cache-loader.service';

@Module({})
export class CacheManagerModule {
    /**
     * Registers the CacheManager with specific data sources statically configured.
     * Primitive settings (TTL, polling, range) are read from config.json / config.yaml.
     * If no dataSource is provided, defaults to the auto-routing GraphQLDataSource.
     */
    static register<T extends IEntity>(options?: { dataSource?: IDataSource<T> }): DynamicModule {
        return {
            module: CacheManagerModule,
            imports: [ConfigModule, GraphQLStitchingModule],
            providers: [
                GraphQLDataSource,
                {
                    provide: 'CACHE_CONFIG',
                    useFactory: (configService: ConfigService, gqlDataSource: GraphQLDataSource<T>): CacheConfig<T> => {
                        const ttlMs = configService.get<number>('cache.ttlMs', 60000);
                        const pollingIntervalMs = configService.get<number>('cache.pollingIntervalMs', 300000);
                        const pollingTimeRange = configService.get<TimeRangeConfig>('cache.pollingTimeRange');
                        const onDemandTimeRange = configService.get<TimeRangeConfig>('cache.onDemandTimeRange');
                        const entitySettings = configService.get<Record<string, { pollingIntervalMs?: number }>>('cache.entitySettings');

                        return {
                            ttlMs,
                            pollingIntervalMs,
                            entitySettings,
                            pollingTimeRange,
                            onDemandTimeRange,
                            dataSource: options?.dataSource || gqlDataSource,
                        };
                    },
                    inject: [ConfigService, GraphQLDataSource],
                },
                CacheStore,
                CacheGroupManager,
                CacheLoaderService,
                CachePollingService,
                CacheManager,
            ],
            exports: [CacheManager],
        };
    }
}
