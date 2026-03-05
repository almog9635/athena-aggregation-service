import { Injectable, Logger } from '@nestjs/common';
import { IDataSource } from './interfaces/datasource.interface';
import { IEntity } from './interfaces/entity.interface';
import { SchemaStitcherService } from '../graphql/schema-stitcher.service';
import { execute, parse, GraphQLObjectType } from 'graphql';
import { CacheErrorMessage } from './enums/error-message.enum';
import { CacheLogMessage } from './enums/log-message.enum';

@Injectable()
export class GraphQLDataSource<T extends IEntity> implements IDataSource<T> {
    private readonly logger = new Logger(GraphQLDataSource.name);

    constructor(private readonly schemaStitcherService: SchemaStitcherService) { }

    async fetch(name: string, days?: string[]): Promise<Partial<T>[]> {
        return this.fetchFromGraphQL(name, days);
    }

    async fetchByIds(name: string, ids: string[], days?: string[]): Promise<Partial<T>[]> {
        const results = await this.fetchFromGraphQL(name, days, ids);
        if (ids && ids.length > 0) {
            return results.filter(r => r.id && ids.includes(r.id));
        }
        return results;
    }

    async fetchAll(days?: string[]): Promise<Partial<T>[]> {
        this.logger.warn(CacheLogMessage.GRAPHQL_FETCH_ALL_WARN);
        return [];
    }

    private async fetchFromGraphQL(name: string, days?: string[], ids?: string[]): Promise<Partial<T>[]> {
        try {
            const schema = await this.schemaStitcherService.getStitchedSchema();
            if (!schema) return [];

            const queryType = schema.getQueryType();
            if (!queryType) return [];

            // Find a query returning a list of `name` or just `name`
            let targetFieldName = '';
            let targetField: any = null;
            for (const [fieldName, field] of Object.entries(queryType.getFields())) {
                let returnType = field.type as any;
                while (returnType.ofType) returnType = returnType.ofType;
                if (returnType.name === name) {
                    targetFieldName = fieldName;
                    targetField = field;
                    break;
                }
            }

            if (!targetFieldName) {
                this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_QUERY_TYPE} '${name}'`);
                return [];
            }

            const objectType = schema.getType(name) as GraphQLObjectType;
            if (!objectType?.getFields) return [];

            // Extract all scalar fields explicitly for the request
            const fields = Object.entries(objectType.getFields())
                .filter(([_, f]) => {
                    let t = f.type as any;
                    while (t.ofType) t = t.ofType;
                    return ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(t.name);
                })
                .map(([n]) => n)
                .join(' ');

            if (!fields) return [];

            const argStrings: string[] = [];
            if (targetField?.args) {
                for (const arg of targetField.args) {
                    if ((arg.name === 'days' || arg.name === 'timeRange') && days && days.length > 0) {
                        const daysList = days.map(d => '"' + d + '"').join(', ');
                        argStrings.push(`${arg.name}: [${daysList}]`);
                    }
                    if (arg.name === 'ids' && ids && ids.length > 0) {
                        const idsList = ids.map(id => '"' + id + '"').join(', ');
                        argStrings.push(`${arg.name}: [${idsList}]`);
                    }
                }
            }
            const argsPart = argStrings.length > 0 ? `(${argStrings.join(', ')})` : '';

            const queryStr = `query { ${targetFieldName}${argsPart} { ${fields} } }`;
            const { data, errors } = await execute({
                schema,
                document: parse(queryStr)
            });

            if (errors && errors.length > 0) {
                this.logger.error(`${CacheErrorMessage.GRAPHQL_QUERY_ERROR} ${name}:`, errors);
            }

            let results: any = data?.[targetFieldName] ?? [];
            if (!Array.isArray(results)) results = [results];

            // Assign structural identity
            return (results as any[]).map((r: any) => ({ ...r, name }));

        } catch (error) {
            this.logger.error(`${CacheErrorMessage.GRAPHQL_EXECUTION_ERROR} ${name}`, error);
            return [];
        }
    }
}
