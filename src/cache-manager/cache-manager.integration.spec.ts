import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from './cache-manager.service';
import { GraphQLDataSource } from './graphql-data-source';
import { SchemaStitcherService } from '../graphql/schema-stitcher.service';
import { IEntity } from './interfaces/entity.interface';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLID, GraphQLInt } from 'graphql';
import { ConfigService } from '@nestjs/config';
import { CacheStore } from './store/cache-store';
import { CacheGroupManager } from './services/cache-group.service';
import { CachePollingService } from './services/cache-polling.service';
import { CacheLoaderService } from './services/cache-loader.service';

interface MissionEntity extends IEntity {
    name: string;
    target: string;
    squadronId: string;
}

describe('CacheManager and DataLoader Real Source Simulation', () => {
    let cacheManager: CacheManager<MissionEntity>;
    let graphqlDataSource: GraphQLDataSource<MissionEntity>;
    let dbFetchCount = 0;

    // Simulated Database
    const dbMissions: Record<string, any> = {
        '1': { __typename: 'Mission', id: '1', name: 'Alpha Strike', target: 'Grid A', squadronId: '1', version: 1 },
        '2': { __typename: 'Mission', id: '2', name: 'Bravo Sweep', target: 'Grid B', squadronId: '1', version: 1 },
        '3': { __typename: 'Mission', id: '3', name: 'Charlie Recon', target: 'Grid C', squadronId: '2', version: 1 },
        '4': { __typename: 'Mission', id: '4', name: 'Delta Drop', target: 'Grid D', squadronId: '2', version: 1 },
    };

    // Construct an executable GraphQL Schema with real resolvers
    const MissionType = new GraphQLObjectType({
        name: 'Mission',
        fields: {
            id: { type: GraphQLID },
            name: { type: GraphQLString },
            target: { type: GraphQLString },
            squadronId: { type: GraphQLString },
            version: { type: GraphQLInt }
        }
    });

    const RootQuery = new GraphQLObjectType({
        name: 'Query',
        fields: {
            Mission: {
                type: new GraphQLList(MissionType),
                args: {
                    ids: { type: new GraphQLList(GraphQLID) },
                    squadronId: { type: new GraphQLList(GraphQLString) }
                },
                resolve: async (_, args) => {
                    dbFetchCount++; // Track how many times the "database" is actually hit
                    
                    // Simulate network latency (20ms)
                    await new Promise(resolve => setTimeout(resolve, 20));

                    let results = Object.values(dbMissions);

                    if (args.ids && args.ids.length > 0) {
                        results = results.filter(m => args.ids.includes(m.id));
                    }

                    if (args.squadronId && args.squadronId.length > 0) {
                        results = results.filter(m => args.squadronId.includes(m.squadronId));
                    }

                    return results;
                }
            }
        }
    });

    const executableSchema = new GraphQLSchema({
        query: RootQuery
    });

    beforeEach(async () => {
        dbFetchCount = 0;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CacheManager,
                CacheStore,
                CacheGroupManager,
                CacheLoaderService,
                CachePollingService,
                GraphQLDataSource,
                {
                    provide: SchemaStitcherService,
                    useValue: {
                        getStitchedSchema: jest.fn().mockResolvedValue(executableSchema)
                    }
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn()
                    }
                },
                {
                    provide: 'CACHE_CONFIG',
                    useFactory: (dataSource: GraphQLDataSource<MissionEntity>) => ({
                        baseTickMs: 1000,
                        pollingIntervalMs: 5000,
                        ttlMs: 60000,
                        dataSource: dataSource,
                    }),
                    inject: [GraphQLDataSource]
                },
                {
                    provide: 'CACHE_LOGGER',
                    useValue: {
                        logHit: jest.fn(),
                        logMiss: jest.fn(),
                        logEviction: jest.fn(),
                        logTtlStart: jest.fn(),
                        logTtlCancel: jest.fn(),
                        logAggregationStart: jest.fn(),
                        logAggregationComplete: jest.fn(),
                        logPollingUpdate: jest.fn(),
                        logRelationDisposal: jest.fn(),
                        logError: jest.fn(),
                        log: jest.fn(),
                        debug: jest.fn(),
                        warn: jest.fn()
                    }
                }
            ],
        }).compile();

        graphqlDataSource = module.get<GraphQLDataSource<MissionEntity>>(GraphQLDataSource);
        cacheManager = module.get<CacheManager<MissionEntity>>(CacheManager);
    });

    afterEach(() => {
        cacheManager.onModuleDestroy();
        jest.clearAllMocks();
    });

    it('should deduplicate multiple concurrent fetchByIds calls into a single database hit using DataLoader', async () => {
        // We simulate 3 different functions asking for different Mission IDs at the exact same time
        const req1 = graphqlDataSource.fetchByIds('Mission', ['1', '2'], undefined, ['id', 'name']);
        const req2 = graphqlDataSource.fetchByIds('Mission', ['2', '3'], undefined, ['id', 'name']);
        const req3 = graphqlDataSource.fetchByIds('Mission', ['4'], undefined, ['id', 'name']);

        const [res1, res2, res3] = await Promise.all([req1, req2, req3]);

        // Assert Results are correctly distributed
        expect(res1).toHaveLength(2);
        expect(res1.map(m => m.id)).toEqual(['1', '2']);
        
        expect(res2).toHaveLength(2);
        expect(res2.map(m => m.id)).toEqual(['2', '3']);
        
        expect(res3).toHaveLength(1);
        expect(res3[0].id).toEqual('4');

        // Assert DataLoader exactly batched them into 1 GraphQL / DB Query!
        // It should have asked for ['1', '2', '3', '4'] in one go.
        expect(dbFetchCount).toBe(1);
    });

    it('should separate batches if the filters differ, but merge if only fields differ', async () => {
        // Request 1 wants 'id', 'name', no filters
        const req1 = graphqlDataSource.fetchByIds('Mission', ['1'], undefined, ['id', 'name']);
        
        // Request 2 wants 'id', 'target', no filters
        const req2 = graphqlDataSource.fetchByIds('Mission', ['2'], undefined, ['id', 'target']);
        
        // Request 3 wants 'id', 'name', but applies a Squadron filter!
        const req3 = graphqlDataSource.fetchByIds('Mission', ['3'], undefined, ['id', 'name'], { squadronId: ['2'] });

        await Promise.all([req1, req2, req3]);

        // Assert they executed as 2 SEPARATE queries. Req1 and Req2 merged into one. Req3 was isolated due to filters.
        expect(dbFetchCount).toBe(2);
    });

    it('should merge batches and union fields if requests ask for the same IDs and squadron but different fields', async () => {
        const filters = { squadronId: ['1'] };

        // Request 1 asks for ['id', 'name']
        const req1 = graphqlDataSource.fetchByIds('Mission', ['1', '2'], undefined, ['id', 'name'], filters);
        
        // Request 2 asks for ['id', 'name', 'target'] (more fields) for the exact same IDs and filters
        const req2 = graphqlDataSource.fetchByIds('Mission', ['1', '2'], undefined, ['id', 'name', 'target'], filters);

        const [res1, res2] = await Promise.all([req1, req2]);

        // Assert that ONLY ONE query was executed! DataLoader grouped them and fired a single query for ['id', 'name', 'target']
        expect(dbFetchCount).toBe(1);
        
        expect(res1).toHaveLength(2);
        expect(res2).toHaveLength(2);
    });

    it('CacheManager should only trigger 1 Discovery query when overlapping groups connect', async () => {
        const days = ['2023-01-01'];

        // User 1 requests GroupA for Squadron 1
        const acquire1 = cacheManager.acquire('Mission', days, 'GroupA', ['id', 'name'], { squadronId: ['1'] });
        
        // User 2 requests GroupB for Squadron 1 (same tenant filter, different group)
        const acquire2 = cacheManager.acquire('Mission', days, 'GroupB', ['id', 'name'], { squadronId: ['1'] });

        await Promise.all([acquire1, acquire2]);

        // CacheManager's pendingAggregations map should have deduplicated the identical root-level pull
        expect(dbFetchCount).toBe(1);
    });
});
