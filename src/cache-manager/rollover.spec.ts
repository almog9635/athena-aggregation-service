import { Test, TestingModule } from '@nestjs/testing';
import { CacheStore } from './store/cache-store';
import { CachePollingService } from './services/cache-polling.service';
import { CacheLoaderService } from './services/cache-loader.service';
import { CacheGroupManager } from './services/cache-group.service';
import { IEntity } from './interfaces/entity.interface';

describe('Midnight Rollover', () => {
    let service: CachePollingService<IEntity>;
    let store: CacheStore<IEntity>;

    const mockConfig = {
        ttlMs: 60000,
        pollingIntervalMs: 10000,
        pollingTimeRange: { pastDays: 1, futureDays: 1 },
        dataGroupMapping: {
            'special-group': [
                {
                    entityName: 'User',
                    fields: ['name'],
                    defaultTimeRange: { pastDays: 0, futureDays: 0 }
                }
            ]
        },
        dataSource: {
            fetch: jest.fn().mockResolvedValue([]),
            fetchAll: jest.fn().mockResolvedValue([]),
            fetchByIds: jest.fn().mockResolvedValue([])
        }
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CachePollingService,
                CacheStore,
                CacheLoaderService,
                CacheGroupManager,
                { provide: 'CACHE_CONFIG', useValue: mockConfig },
            ],
        }).compile();

        service = module.get<CachePollingService<IEntity>>(CachePollingService);
        store = module.get<CacheStore<IEntity>>(CacheStore);

        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-24T12:00:00Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should correctly calculate active days union for purge protection', () => {
        const activeDays = service.getActiveDays();
        // Today Mar 24. Global [1 p, 1 f] -> [Mar 23, Mar 24, Mar 25]
        expect(activeDays).toContain('2026-03-23');
        expect(activeDays).toContain('2026-03-24');
        expect(activeDays).toContain('2026-03-25');
        expect(activeDays.length).toBe(3);
    });

    it('should purge stale days when midnight rollover triggers', async () => {
        const yesterday = '2026-03-23';
        const today = '2026-03-24';
        
        // Seed some data for Mar 23 and Mar 24
        store.storeInCache({ id: '1', version: 1 } as any, 'User', '1', [yesterday]);
        store.storeInCache({ id: '2', version: 1 } as any, 'User', '2', [today]);
        
        expect(store.getItem('User', '1', yesterday)).toBeDefined();
        expect(store.getItem('User', '2', today)).toBeDefined();

        // Advance time to Mar 25
        jest.setSystemTime(new Date('2026-03-25T12:00:00Z'));
        
        // Explicitly trigger the rollover logic
        await (service as any).executeRollover();

        // Window on Mar 25 is [Mar 24, Mar 25, Mar 26]
        // Mar 23 should be gone
        expect(store.getItem('User', '1', yesterday)).toBeUndefined();
        // Mar 24 is still relevant (Yesterday for Mar 25)
        expect(store.getItem('User', '2', today)).toBeDefined();
    });
});
