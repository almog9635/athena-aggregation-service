import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from './cache-manager.service';
import { CacheConfig } from './interfaces/cache-config.interface';
import { ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger } from './logger/cache-logger.service';
import { MockDataSource } from '../../test/mock-data-source';

interface TestEntity extends ITimeDependentEntity {
    fieldA?: string;
    fieldB?: number;
    squadronId?: string;
}

describe('CacheManager', () => {
    let cacheManager: CacheManager<TestEntity>;
    let sourceA: MockDataSource<TestEntity>;
    let sourceB: MockDataSource<TestEntity>;
    let logger: DefaultCacheLogger;

    const mockConfig: CacheConfig<TestEntity> = {
        ttlMs: 50,
        pollingIntervalMs: 0,
        pollingTimeRange: { pastDays: 7, futureDays: 7 },
        onDemandTimeRange: { pastDays: 30, futureDays: 30 },
        entitySettings: {},
        dataSource: {} as any, // Injected down below in beforeEach
    };

    beforeEach(async () => {
        const stitchedSource = new MockDataSource<TestEntity>({
            'entity1': [{ id: '1', name: 'entity1', fieldA: 'ValueA', fieldB: 42, version: 1, squadronId: '1' }]
        }, 0);

        mockConfig.dataSource = stitchedSource;
        logger = new DefaultCacheLogger();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CacheManager,
                { provide: 'CACHE_CONFIG', useValue: mockConfig },
                { provide: 'CACHE_LOGGER', useValue: logger },
            ],
        }).compile();

        cacheManager = module.get<CacheManager<TestEntity>>(CacheManager);
        jest.useFakeTimers();
    });

    afterEach(() => {
        cacheManager.onModuleDestroy();
        jest.useRealTimers();
    });

    describe('Aggregation Logic', () => {
        it('should execute fetch from the unified source', async () => {
            const promise = cacheManager.acquire('entity1', undefined, 'testGroup');
            const results = await promise;

            expect(results).toBeDefined();
            expect(results.length).toBe(1);
            expect(results[0].name).toBe('entity1');
            expect(results[0].id).toBe('1');
            expect(results[0].version).toBe(1);
            expect(results[0].fieldA).toBe('ValueA');
            expect(results[0].fieldB).toBe(42);
        });
    });

    describe('TTL and Ref Counting', () => {
        it('should set activeGroups on acquire and delete after TTL when size is 0', async () => {
            // Ignore background aggregation promises in this test structure by mocking timers
            const acquirePromise = cacheManager.acquire('entity1', undefined, 'testGroup');
            const entities = await acquirePromise;

            // Access private map to check state
            const indepMap = (cacheManager as any).timeIndependentMap;
            const nameMap = indepMap.get('entity1');
            const cacheItem = nameMap ? nameMap.get('1') : undefined;

            expect(cacheItem).toBeDefined();
            expect(cacheItem!.activeGroups.has('testGroup')).toBe(true);

            // Release it
            cacheManager.release('entity1', undefined, 'testGroup');
            expect(cacheItem!.activeGroups.has('testGroup')).toBe(false);
            expect(cacheItem!.activeGroups.size).toBe(0);

            // It should NOT be deleted immediately
            expect(indepMap.has('entity1')).toBe(true);

            // Fast forward past TTL (50ms)
            jest.advanceTimersByTime(60);

            // It SHOULD be deleted now
            expect(indepMap.has('entity1')).toBe(false);
        });

        it('should cancel TTL if re-acquired before timeout', async () => {
            const p1 = cacheManager.acquire('entity1', undefined, 'testGroup');
            await p1;

            cacheManager.release('entity1', undefined, 'testGroup');

            // Fast forward a little bit, but less than TTL
            jest.advanceTimersByTime(20);

            // Re-acquire before TTL expires
            const p2 = cacheManager.acquire('entity1', undefined, 'testGroup');
            await p2;

            // Fast forward past the original TTL
            jest.advanceTimersByTime(40);

            // It should still exist because TTL was cancelled!
            const indepMap = (cacheManager as any).timeIndependentMap;
            expect(indepMap.has('entity1')).toBe(true);
            expect(indepMap.get('entity1').get('1').activeGroups.size).toBe(1);
        });
    });

    describe('Multi-Day Entities', () => {
        it('should store multi-day entities under exact same reference without duplication', async () => {
            const days = ['2023-01-01', '2023-01-02'];

            const p1 = cacheManager.acquire('entity1', days, 'testGroup');
            const entities = await p1;

            expect(entities[0].days).toEqual(days);

            const map = (cacheManager as any).timeDependentMap;
            const day1Map = map.get(days[0]);
            const day2Map = map.get(days[1]);

            expect(day1Map).toBeDefined();
            expect(day2Map).toBeDefined();

            const item1 = day1Map.get('entity1').get('1');
            const item2 = day2Map.get('entity1').get('1');

            // They should point to the exact same object reference
            expect(item1 === item2).toBe(true);
            expect(item1.activeGroups.size).toBe(1);
        });
    });

    describe('Multi-Tenancy and Isolation', () => {
        it('should create different aggregation keys for different subscriberFilters', async () => {
            const days = ['2023-01-01'];
            
            // Acquire for Squadron 1
            await cacheManager.acquire('entity1', days, 'group1', ['fieldA'], { squadronId: ['1'] });
            
            // Acquire for Squadron 2
            await cacheManager.acquire('entity1', days, 'group1', ['fieldA'], { squadronId: ['2'] });
            
            expect((cacheManager as any).fullyLoadedKeys.size).toBe(2);
            
            const keys = Array.from((cacheManager as any).fullyLoadedKeys);
            expect(keys[0]).not.toEqual(keys[1]);
        });

        it('should correctly release based on subscriberFilters', async () => {
            const days = ['2023-01-01'];
            const filters = { squadronId: ['1'] };
            
            await cacheManager.acquire('entity1', days, 'group1', ['fieldA'], filters);
            
            const indepMap = (cacheManager as any).timeDependentMap;
            const item = indepMap.get('2023-01-01').get('entity1').get('1');
            
            expect(item.activeGroups.has('group1')).toBe(true);
            
            // Release with WRONG filters should not clear it (using memory filter logic in release)
            cacheManager.release('entity1', days, 'group1', { squadronId: ['999'] });
            expect(item.activeGroups.has('group1')).toBe(true);
            
            // Release with CORRECT filters should clear it
            cacheManager.release('entity1', days, 'group1', filters);
            expect(item.activeGroups.has('group1')).toBe(false);
        });
    });
});
