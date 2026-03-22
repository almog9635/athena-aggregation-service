import { Injectable, Logger } from '@nestjs/common';
import { IDataSource } from './interfaces/datasource.interface';
import { IEntity } from './interfaces/entity.interface';
import { SchemaStitcherService } from '../graphql/schema-stitcher.service';
import { execute, parse, GraphQLObjectType } from 'graphql';
import { CacheErrorMessage } from './enums/error-message.enum';
import { CacheLogMessage } from './enums/log-message.enum';
import DataLoader from 'dataloader';

interface FetchKey {
    name: string;
    id: string;
    daysStr: string;
    fieldsStr: string;
    filtersStr: string;
    days?: string[];
    requestedFields?: string[];
    subscriberFilters?: Record<string, any>;
}

@Injectable()
export class GraphQLDataSource<T extends IEntity> implements IDataSource<T> {
    private readonly logger = new Logger(GraphQLDataSource.name);

    constructor(private readonly schemaStitcherService: SchemaStitcherService) { }

    private readonly dataLoader = new DataLoader<FetchKey, Partial<T> | null>(async (keys) => {
        // Group keys by their common signature (name + days + filters) ignoring fields
        const grouped = new Map<string, FetchKey[]>();

        for (const k of keys) {
            const signature = `${k.name}|${k.daysStr}|${k.filtersStr}`;
            let group = grouped.get(signature);

            if (!group) {
                group = [];
                grouped.set(signature, group);
            }

            group.push(k);
        }

        const resultsMap = new Map<FetchKey, Partial<T> | null>();

        // Fire all groups in parallel
        await Promise.all(Array.from(grouped.values()).map(async (groupKeys) => {
            const first = groupKeys[0];
            const ids = Array.from(new Set(groupKeys.map(k => k.id))); // deduplicate IDs for the query

            // Union all requested fields in this group
            let mergedFields: string[] | undefined = [];
            let fetchAllFields = false;
            groupKeys.forEach(k => {
                if (!fetchAllFields) {
                    if (!k.requestedFields || k.requestedFields.length === 0) {
                        fetchAllFields = true;
                    } else {
                        k.requestedFields.forEach(f => mergedFields!.push(f));
                    }
                }
            });

            if (fetchAllFields) {
                mergedFields = undefined; // If any request wants everything, we fetch everything
            } else {
                mergedFields = Array.from(new Set(mergedFields));
            }

            // Fire GraphQL query for this specific group of IDs
            const results = await this.fetchFromGraphQL(first.name, first.days, ids, mergedFields, first.subscriberFilters);

            // Map results back to IDs
            const idToResult = new Map<string, Partial<T>>();
            for (const r of results) {
                if (r.id) idToResult.set(r.id, r);
            }

            for (const k of groupKeys) {
                resultsMap.set(k, idToResult.get(k.id) || null);
            }
        }));

        // DataLoader requires returning an array of results matching the EXACT length and order of the keys array
        return keys.map(k => resultsMap.get(k) || null);
    }, {
        // cache: false ensures it only deduplicates execution within a single Node.js tick (Event Loop), 
        // passing freshly updated data to the CacheManager without holding onto stale references.
        cache: false
    });

    async fetch(name: string, days?: string[], requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<Partial<T>[]> {
        return this.fetchFromGraphQL(name, days, undefined, requestedFields, subscriberFilters);
    }

    async fetchByIds(name: string, ids: string[], days?: string[], requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<Partial<T>[]> {
        if (!ids || ids.length === 0) return [];

        const daysStr = days ? days.join(',') : '';
        const fieldsStr = requestedFields ? requestedFields.join(',') : '';
        const filtersStr = subscriberFilters ? Buffer.from(JSON.stringify(subscriberFilters)).toString('base64') : '';

        const keys: FetchKey[] = ids.map(id => ({
            name, id, days, requestedFields, subscriberFilters,
            daysStr, fieldsStr, filtersStr
        }));

        const results = await this.dataLoader.loadMany(keys);

        // Filter out nulls/errors from the DataLoader response
        return results.filter(r => r != null && !(r instanceof Error)) as Partial<T>[];
    }

    async fetchAll(days?: string[]): Promise<Partial<T>[]> {
        this.logger.warn(CacheLogMessage.GRAPHQL_FETCH_ALL_WARN);
        return [];
    }

    private buildGraphQLFieldsFromPaths(paths: string[]): string {
        const root: any = {};
        for (const path of paths) {
            const parts = path.split('.');
            let current = root;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!current[part]) {
                    current[part] = (i === parts.length - 1) ? true : {};
                }
                current = current[part];
            }
        }

        const buildSelection = (obj: any): string => {
            let selection = '';
            let hasNested = false;
            for (const key of Object.keys(obj)) {
                if (obj[key] === true) {
                    selection += `${key} `;
                } else {
                    hasNested = true;
                    selection += `${key} { ${buildSelection(obj[key])} } `;
                }
            }
            if (hasNested || selection.length > 0) {
                selection += '__typename ';
            }
            return selection.trim();
        };

        const result = buildSelection(root);
        return result.includes('__typename') ? result : result + ' __typename';
    }

    private normalizeResponse(results: any[], rootName: string): Partial<T>[] {
        const flattenedEntities: any[] = [];

        const extractEntities = (obj: any, isRoot = false) => {
            if (!obj || typeof obj !== 'object') return obj;

            if (Array.isArray(obj)) {
                return obj.map(item => extractEntities(item));
            }

            const newObj: any = {};
            let isEntity = false;

            // Sub-entities must have both __typename and id natively requested
            if (obj.__typename && obj.id) {
                isEntity = true;
            }

            for (const key of Object.keys(obj)) {
                const value = obj[key];

                if (Array.isArray(value)) {
                    newObj[key] = value.map(v => extractEntities(v));
                } else if (value && typeof value === 'object') {
                    newObj[key] = extractEntities(value);
                } else {
                    newObj[key] = value;
                }
            }

            if (isEntity) {
                const entityName = isRoot ? rootName : newObj.__typename;
                flattenedEntities.push({
                    ...newObj,
                    name: entityName
                });

                if (!isRoot) {
                    return { id: newObj.id, __typename: newObj.__typename };
                }
            }

            return newObj;
        };

        for (const r of results) {
            const entity = extractEntities(r, true);
            // If the root wasn't an entity (e.g. missing __typename/id), still add it to the root
            if (!r.__typename || !r.id) {
                flattenedEntities.push({ ...entity, name: rootName });
            }
        }

        return flattenedEntities;
    }

    private async fetchFromGraphQL(name: string, days?: string[], ids?: string[], requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<Partial<T>[]> {
        try {
            const schema = await this.schemaStitcherService.getStitchedSchema();

            if (!schema) {
                this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_SCHEMA} '${name}'`);
                return [];
            }

            const queryType = schema.getQueryType();
            if (!queryType) {
                this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_QUERY_TYPE} '${name}'`);
                return [];
            }

            const { targetFieldName, targetField } = this.getTargetField(schema, name);

            if (!targetFieldName) {
                this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_QUERY_TYPE} '${name}'`);
                return [];
            }

            const objectType = schema.getType(name) as GraphQLObjectType;

            if (!objectType?.getFields) {
                this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_QUERY_TYPE} '${name}'`);
                return [];
            }

            const fieldsString = this.buildFieldsString(objectType, name, requestedFields);

            if (!fieldsString) {
                return [];
            }

            const argsPart = this.buildQueryArguments(targetField, days, ids, subscriberFilters);

            const queryStr = `query { ${targetFieldName}${argsPart} { ${fieldsString} } }`;
            const { data, errors } = await execute({
                schema,
                document: parse(queryStr)
            });

            if (errors && errors.length > 0) {
                this.logger.error(`${CacheErrorMessage.GRAPHQL_QUERY_ERROR} ${name}:`, errors);
            }

            let results: any = data?.[targetFieldName] ?? [];

            if (!Array.isArray(results)) {
                results = [results];
            }

            // Normalize the response to flatten associated complex entities
            return this.normalizeResponse(results, name);

        } catch (error) {
            this.logger.error(`${CacheErrorMessage.GRAPHQL_EXECUTION_ERROR} ${name}`, error);
            return [];
        }
    }

    private getTargetField(schema: any, name: string): { targetFieldName: string, targetField: any } {
        const queryType = schema.getQueryType();
        if (!queryType) return { targetFieldName: '', targetField: null };

        const fields = Object.entries(queryType.getFields());
        const foundField = fields.find(([_, field]) => {
            let returnType = (field as any).type;
            while (returnType.ofType) returnType = returnType.ofType;
            return returnType.name === name;
        });

        return foundField
            ? { targetFieldName: foundField[0], targetField: foundField[1] }
            : { targetFieldName: '', targetField: null };
    }

    private buildFieldsString(objectType: GraphQLObjectType, name: string, requestedFields?: string[]): string {
        if (requestedFields && requestedFields.length > 0) {
            return this.buildGraphQLFieldsFromPaths(requestedFields);
        }

        const fieldsString = Object.entries(objectType.getFields())
            .filter(([_, f]) => {
                let t = f.type as any;
                while (t.ofType) t = t.ofType;
                return ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(t.name);
            })
            .map(([n]) => n)
            .join(' ') + ' __typename';

        if (!fieldsString.trim() || fieldsString.trim() === '__typename') {
            this.logger.debug(`${CacheErrorMessage.GRAPHQL_NO_QUERY_TYPE} '${name}'`);
            return '';
        }

        return fieldsString;
    }

    private buildQueryArguments(targetField: any, days?: string[], ids?: string[], subscriberFilters?: Record<string, any>): string {
        if (!targetField?.args) return '';

        const argStrings: string[] = [];

        targetField.args.forEach((arg: any) => {
            if ((arg.name === 'days' || arg.name === 'timeRange') && days && days.length > 0) {
                const formattedDays = days.map(d => `"${d}"`).join(', ');
                argStrings.push(`${arg.name}: [${formattedDays}]`);
            }

            if (arg.name === 'ids' && ids && ids.length > 0) {
                const formattedIds = ids.map(id => `"${id}"`).join(', ');
                argStrings.push(`${arg.name}: [${formattedIds}]`);
            }

            if (subscriberFilters) {
                Object.entries(subscriberFilters).forEach(([filterKey, filterValue]) => {
                    if (arg.name === filterKey && filterValue !== undefined && filterValue !== null) {
                        let val: string;

                        if (Array.isArray(filterValue)) {
                            const items = filterValue.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
                            val = `[${items}]`;
                        } else {
                            val = typeof filterValue === 'string' ? `"${filterValue}"` : String(filterValue);
                        }
                        argStrings.push(`${arg.name}: ${val}`);
                    }
                });
            }
        });

        return argStrings.length > 0 ? `(${argStrings.join(', ')})` : '';
    }
}
