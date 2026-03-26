import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from './cache-manager.service';
import { CacheLoaderService } from './services/cache-loader.service';
import { CachePollingService } from './services/cache-polling.service';
import { CacheStore } from './store/cache-store';
import { CacheGroupManager } from './services/cache-group.service';
import { GraphQLDataSource } from './graphql-data-source';
import { IEntity, ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger } from './logger/cache-logger.service';

interface MissionEntity extends ITimeDependentEntity {
    name: string;
    target: string;
}

describe('Floating Entities (Day Migration)', () => {
    let cacheManager: CacheManager<MissionEntity>;
    let cacheStore: CacheStore<MissionEntity>;
    let cachePollingService: CachePollingService<MissionEntity>;

    // Simulated Database that changes state
    let databaseState: MissionEntity = {
        id: '1',
        name: 'Mission',
        target: 'Grid A',
        version: 1,
        days: ['2023-01-01']
    } as any;

    beforeEach(async () => {
        const mockDataSource = {
            fetch: jest.fn().mockImplementation(async (entityName, days) => {
                if (days?.includes(databaseState.days[0])) {
                    return [databaseState];
                }
                return [];
            }),
            fetchByIds: jest.fn().mockImplementation(async () => {
                return [databaseState];
            })
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CacheManager,
                CacheLoaderService,
                CachePollingService,
                CacheStore,
                CacheGroupManager,
                {
                    provide: 'CACHE_CONFIG',
                    useValue: {
                        ttlMs: 60000,
                        pollingIntervalMs: 5000,
                        dataSource: mockDataSource
                    }
                },
                { provide: 'CACHE_LOGGER', useValue: new DefaultCacheLogger() }
            ]
        }).compile();

        cacheManager = module.get<CacheManager<MissionEntity>>(CacheManager);
        cacheStore = module.get<CacheStore<MissionEntity>>(CacheStore);
        cachePollingService = module.get<CachePollingService<MissionEntity>>(CachePollingService);
    });

    afterEach(() => {
        cacheManager.onModuleDestroy();
        cachePollingService.onModuleDestroy();
    });

    it('should correctly re-index an entity that shifts its days property across updates', async () => {
        // 1. Initial Acquire - Entity is loaded into the cache under '2023-01-01'
        await cacheManager.acquire('Mission', ['2023-01-01'], 'testGroup', ['target']);

        // Verify it exists in CacheStore under exactly 2023-01-01
        let item01 = cacheStore.getExistingCacheItem('Mission', '1', ['2023-01-01']);
        let item02 = cacheStore.getExistingCacheItem('Mission', '1', ['2023-01-02']);

        expect(item01).toBeDefined();
        expect(item02).toBeUndefined();
        expect(item01?.data.version).toBe(1);

        // 2. Database shifts the entity to '2023-01-02' and increments version to 2
        databaseState = {
            ...databaseState,
            days: ['2023-01-02'],
            version: 2
        };

        // 3. Simulate Polling (Data source will return the new state)
        // Polling runs on existing active entries. We will trigger the executePollFetch explicitly
        // to exactly mimic the background worker detecting the ID and fetching it.
        await (cachePollingService as any).executePollFetch('Mission', ['1'], ['2023-01-01']);

        // 4. Verify the entity successfully "floated" to the new day bucket and detached from the old one
        item01 = cacheStore.getExistingCacheItem('Mission', '1', ['2023-01-01']);
        item02 = cacheStore.getExistingCacheItem('Mission', '1', ['2023-01-02']);

        expect(item01).toBeUndefined(); // Should be completely gone from the old bucket
        expect(item02).toBeDefined();   // Should exist in the new bucket
        expect(item02?.data.version).toBe(2);
        expect(item02?.data.days).toEqual(['2023-01-02']);
    });
});
