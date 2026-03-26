import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from './cache-manager.service';
import { CacheStore } from './store/cache-store';
import { CacheGroupManager } from './services/cache-group.service';
import { CachePollingService } from './services/cache-polling.service';
import { CacheLoaderService } from './services/cache-loader.service';
import { DefaultCacheLogger } from './logger/cache-logger.service';
import { IDataSource } from './interfaces/datasource.interface';
import { isInsideConfigRange } from './utils/time.util';

describe('Date Configuration Logic', () => {
    let cacheManager: CacheManager<any>;
    let dataSource: jest.Mocked<IDataSource<any>>;

    const mockDate = new Date('2026-03-18T10:00:00Z'); // Wednesday
    const lastFriday = '2026-03-13';

    const mockConfig = {
        dataSource: {} as any,
        ttlMs: 60000,
        baseTickMs: 5000,
        pollingIntervalMs: 300000,
        pollingTimeRange: {
            pastDays: 3,
            futureDays: 3
        },
        onDemandTimeRange: {
            pastDays: 30,
            futureDays: 14
        }
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.setSystemTime(mockDate);

        dataSource = {
            fetch: jest.fn().mockResolvedValue([{ id: '1', name: 'Mission', version: 1 }]),
            fetchByIds: jest.fn().mockResolvedValue([{ id: '1', name: 'Mission', version: 1 }]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CacheManager,
                CacheStore,
                CacheGroupManager,
                CachePollingService,
                CacheLoaderService,
                { provide: 'CACHE_LOGGER', useValue: new DefaultCacheLogger() },
                {
                    provide: 'CACHE_CONFIG',
                    useValue: {
                        dataSource,
                        ttlMs: 60000,
                        baseTickMs: 5000,
                        pollingIntervalMs: 300000,
                        pollingTimeRange: {
                            pastDays: 3,
                            futureDays: 3
                        },
                        onDemandTimeRange: {
                            pastDays: 30,
                            futureDays: 14
                        }
                    },
                },
                {
                    provide: 'CACHE_LOGGER',
                    useValue: {
                        logHit: jest.fn(),
                        logMiss: jest.fn(),
                        logAggregationStart: jest.fn(),
                        logAggregationComplete: jest.fn(),
                        logPollingUpdate: jest.fn(),
                        logError: jest.fn(),
                        logRelationDisposal: jest.fn(),
                    },
                },
            ],
        }).compile();

        cacheManager = module.get<CacheManager<any>>(CacheManager);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should return true if entirely within valid polling range', () => {
        const inRange = isInsideConfigRange(
            ['2026-03-18', '2026-03-21'],
            mockConfig.pollingTimeRange
        );
        expect(inRange).toBe(true);
    });

    it('should identify Last Friday as OUTSIDE polling range if pastDays is 1', () => {
        // Start of week is 2026-03-15 (Sunday). 
        // 1 day before is 2016-03-14 (Saturday).
        // Friday the 13th is outside.
        const isPolling = isInsideConfigRange([lastFriday], { pastDays: 0, futureDays: 6 });
        expect(isPolling).toBe(false);
    });

    it('should fetch "Last Friday" on-demand even if outside polling range', async () => {
        // Set polling range to exclude Friday
        const config = mockConfig;
        config.pollingTimeRange = { pastDays: 1, futureDays: 1 };

        await cacheManager.acquire('Mission', [lastFriday], 'testGroup');

        expect(dataSource.fetch).toHaveBeenCalledWith('Mission', [lastFriday], undefined, undefined);
    });

    it('should NOT poll an entity that is in On-Demand range but NOT Polling range', async () => {
        const config = mockConfig;
        config.pollingTimeRange = { pastDays: 1, futureDays: 1 };
        config.pollingIntervalMs = 1000;

        await cacheManager.acquire('Mission', [lastFriday], 'testGroup');
        dataSource.fetch.mockClear();

        // Advance time
        jest.advanceTimersByTime(5000);
        
        // Should NOT have polled because it's outside polling range
        expect(dataSource.fetchByIds).not.toHaveBeenCalled();
    });
});
