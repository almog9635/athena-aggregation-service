import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stitchSchemas } from '@graphql-tools/stitch';
import { fetch } from 'cross-fetch';
import { buildHTTPExecutor } from '@graphql-tools/executor-http';
import { schemaFromExecutor, wrapSchema } from '@graphql-tools/wrap';
import { GraphQLSchema, buildSchema } from 'graphql';
import { CacheErrorMessage } from '../cache-manager/enums/error-message.enum';
import { CacheLogMessage } from '../cache-manager/enums/log-message.enum';

@Injectable()
export class SchemaStitcherService {
    private readonly logger = new Logger(SchemaStitcherService.name);
    private stitchedSchema: GraphQLSchema | null = null;

    constructor(private readonly configService: ConfigService) { }

    async getStitchedSchema(): Promise<GraphQLSchema> {
        if (this.stitchedSchema) {
            return this.stitchedSchema;
        }

        const sources = this.configService.get<{ name: string; url: string }[]>('graphql.sources') || [];
        const subschemas: any[] = [];

        for (const source of sources) {
            try {
                this.logger.log(`${CacheLogMessage.GRAPHQL_INTROSPECTING} ${source.name} at ${source.url}`);
                const executor = buildHTTPExecutor({
                    endpoint: source.url,
                    fetch: fetch
                });

                // schemaFromExecutor can be a promise in older versions, await it just in case using Promise.resolve
                const schema = await Promise.resolve(schemaFromExecutor(executor));
                subschemas.push({
                    schema: wrapSchema({
                        schema,
                        executor
                    }),
                });
                this.logger.log(`${CacheLogMessage.GRAPHQL_INTROSPECTED_SUCCESS} ${source.name}`);
            } catch (error) {
                this.logger.error(`${CacheErrorMessage.GRAPHQL_INTROSPECTION_ERROR} ${source.name} at ${source.url}`, error);
            }
        }

        if (subschemas.length > 0) {
            this.stitchedSchema = stitchSchemas({
                subschemas,
            });
        } else {
            this.stitchedSchema = buildSchema(`
                type Query {
                    _empty: String
                }
            `);
        }

        return this.stitchedSchema;
    }
}
