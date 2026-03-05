import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheManager } from './cache-manager.service';
import { CacheConfig, TimeRangeConfig } from './interfaces/cache-config.interface';
import { IDataSource } from './interfaces/datasource.interface';
import { IEntity } from './interfaces/entity.interface';
import { GraphQLStitchingModule } from '../graphql/graphql-stitching.module';
import { GraphQLDataSource } from './graphql-data-source';

@Module({})
export class CacheManagerModule {
    /**
     * Registers the CacheManager with specific data sources statically configured.
     * Primitive settings (TTL, polling, range) are read from config.json / config.yaml.
     * If no dataSources are provided, defaults to the auto-routing GraphQLDataSource.
     */
    static register<T extends IEntity>(options?: { dataSources?: IDataSource<T>[] }): DynamicModule {
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
                        const timeRange = configService.get<TimeRangeConfig>('cache.timeRange');

                        return {
                            ttlMs,
                            pollingIntervalMs,
                            timeRange,
                            dataSources: options?.dataSources?.length ? options.dataSources : [gqlDataSource],
                        };
                    },
                    inject: [ConfigService, GraphQLDataSource],
                },
                CacheManager,
            ],
            exports: [CacheManager],
        };
    }
}
