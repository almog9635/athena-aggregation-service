import { Injectable } from '@nestjs/common';
import { GqlOptionsFactory } from '@nestjs/graphql';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { SchemaStitcherService } from './schema-stitcher.service';

@Injectable()
export class StitchingConfigService implements GqlOptionsFactory {
    constructor(private readonly schemaStitcherService: SchemaStitcherService) { }

    async createGqlOptions(): Promise<ApolloDriverConfig> {
        const schema = await this.schemaStitcherService.getStitchedSchema();

        return {
            schema,
        };
    }
}
