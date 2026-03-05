import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { StitchingConfigService } from './stitching-config.service';
import { SchemaStitcherService } from './schema-stitcher.service';

@Module({
    providers: [StitchingConfigService, SchemaStitcherService],
    exports: [SchemaStitcherService, StitchingConfigService],
})
export class StitchingConfigModule { }

@Module({
    imports: [
        StitchingConfigModule,
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
            driver: ApolloDriver,
            imports: [StitchingConfigModule],
            useExisting: StitchingConfigService,
        }),
    ],
    exports: [GraphQLModule, StitchingConfigModule],
})
export class GraphQLStitchingModule { }
