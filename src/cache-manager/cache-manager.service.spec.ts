import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from './cache-manager.service';
import { CacheConfig } from './interfaces/cache-config.interface';
import { ITimeDependentEntity } from './interfaces/entity.interface';
import { DefaultCacheLogger } from './logger/cache-logger.service';
import { MockDataSource } from '../../test/mock-data-source';

interface TestEntity extends ITimeDependentEntity {
    fieldA?: string;
    fieldB?: number;
}

describe('CacheManager', () => {
    let cacheManager: CacheManager<TestEntity>;
    let sourceA: MockDataSource<TestEntity>;
    let sourceB: MockDataSource<TestEntity>;
    let logger: DefaultCacheLogger;

    const mockConfig: CacheConfig<TestEntity> = {
        ttlMs: 50,
        pollingIntervalMs: 0,
        timeRange: { pastDays: 7, futureDays: 7 },
        dataSources: [],
    };

    beforeEach(async () => {
        sourceA = new MockDataSource<TestEntity>({
            'entity1': { fieldA: 'ValueA', version: 1 }
        }, 10);

        sourceB = new MockDataSource<TestEntity>({
            'entity1': { fieldB: 42, version: 1 }
        }, 10);

        mockConfig.dataSources = [sourceA, sourceB];
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
        it('should aggregate fields from multiple sources concurrently', async () => {
            // Both sources take 10ms, but run concurrently, so it should resolve relatively fast
            const promise = cacheManager.acquire('entity1');
            jest.advanceTimersByTime(20);
            const result = await promise;

            expect(result).toBeDefined();
            expect(result.name).toBe('entity1');
            expect(result.version).toBe(1);
            expect(result.fieldA).toBe('ValueA');
            expect(result.fieldB).toBe(42);
        });
    });

    describe('TTL and Ref Counting', () => {
        it('should increment refCount on acquire and delete after TTL when refCount is 0', async () => {
            // Ignore background aggregation promises in this test structure by mocking timers
            const acquirePromise = cacheManager.acquire('entity1');
            jest.advanceTimersByTime(20); // allow the 10ms network delay to finish
            const entity = await acquirePromise;

            // Access private map to check state
            const map = (cacheManager as any).timeIndependentMap;
            const cacheItem = map.get('entity1');

            expect(cacheItem).toBeDefined();
            expect(cacheItem.refCount).toBe(1);

            // Release it
            cacheManager.release('entity1');
            expect(cacheItem.refCount).toBe(0);

            // It should NOT be deleted immediately
            expect(map.has('entity1')).toBe(true);

            // Fast forward past TTL (50ms)
            jest.advanceTimersByTime(60);

            // It SHOULD be deleted now
            expect(map.has('entity1')).toBe(false);
        });

        it('should cancel TTL if re-acquired before timeout', async () => {
            const p1 = cacheManager.acquire('entity1');
            jest.advanceTimersByTime(20);
            await p1;

            cacheManager.release('entity1');

            // Fast forward a little bit, but less than TTL
            jest.advanceTimersByTime(20);

            // Re-acquire before TTL expires
            const p2 = cacheManager.acquire('entity1');
            jest.advanceTimersByTime(10);
            await p2;

            // Fast forward past the original TTL
            jest.advanceTimersByTime(40);

            // It should still exist because TTL was cancelled!
            const map = (cacheManager as any).timeIndependentMap;
            expect(map.has('entity1')).toBe(true);
            expect(map.get('entity1').refCount).toBe(1);
        });
    });

    describe('Multi-Day Entities', () => {
        it('should store multi-day entities under exact same reference without duplication', async () => {
            const days = ['2023-01-01', '2023-01-02'];

            const p1 = cacheManager.acquire('entity1', days);
            jest.advanceTimersByTime(20);
            const entity = await p1;

            expect(entity.days).toEqual(days);

            const map = (cacheManager as any).timeDependentMap;
            const day1Map = map.get(days[0]);
            const day2Map = map.get(days[1]);

            expect(day1Map).toBeDefined();
            expect(day2Map).toBeDefined();

            const item1 = day1Map.get('entity1');
            const item2 = day2Map.get('entity1');

            // They should point to the exact same object reference
            expect(item1 === item2).toBe(true);
            expect(item1.refCount).toBe(1);
        });
    });
});
