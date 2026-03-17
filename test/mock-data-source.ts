import { IDataSource } from '../src/cache-manager/interfaces/datasource.interface';
import { IEntity } from '../src/cache-manager/interfaces/entity.interface';

/**
 * A mock data source used for testing the CacheManager.
 * It simulates a GraphQL endpoint by returning configurable entity fragments,
 * and allows for simulated network delays to test concurrency.
 */
export class MockDataSource<T extends IEntity> implements IDataSource<T> {
    private mockData: Record<string, Partial<T>[]> = {};
    private delayMs: number = 0;

    constructor(mockData: Record<string, Partial<T>[]> = {}, delayMs: number = 0) {
        this.mockData = mockData;
        this.delayMs = delayMs;
    }

    setMockData(data: Record<string, Partial<T>[]>) {
        this.mockData = data;
    }

    setDelay(ms: number) {
        this.delayMs = ms;
    }

    async fetch(name: string, days?: string[], requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<Partial<T>[]> {
        if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }

        const dataArr = this.mockData[name];
        if (!dataArr) {
            return [];
        }

        return dataArr.map(d => ({ ...d }));
    }

    async fetchByIds(name: string, ids: string[], days?: string[], requestedFields?: string[], subscriberFilters?: Record<string, any>): Promise<Partial<T>[]> {
        const dataArr = await this.fetch(name, days, requestedFields, subscriberFilters);
        return dataArr.filter(d => d.id && ids.includes(d.id));
    }
}
