import { IDataSource } from '../src/cache-manager/interfaces/datasource.interface';
import { IEntity } from '../src/cache-manager/interfaces/entity.interface';

/**
 * A mock data source used for testing the CacheManager.
 * It simulates a GraphQL endpoint by returning configurable partial entities,
 * and allows for simulated network delays to test concurrency.
 */
export class MockDataSource<T extends IEntity> implements IDataSource<T> {
    private mockData: Record<string, Partial<T>> = {};
    private delayMs: number = 0;

    constructor(mockData: Record<string, Partial<T>> = {}, delayMs: number = 0) {
        this.mockData = mockData;
        this.delayMs = delayMs;
    }

    /**
     * Updates the mock data available to this source.
     */
    setMockData(data: Record<string, Partial<T>>) {
        this.mockData = data;
    }

    /**
     * Sets the artificial delay to simulate network latency.
     */
    setDelay(ms: number) {
        this.delayMs = ms;
    }

    /**
     * Simulates fetching a partial slice of the entity.
     */
    async fetch(name: string, days?: string[]): Promise<Partial<T>> {
        if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }

        const data = this.mockData[name];
        if (!data) {
            // Return an empty object if no data is mocked for this entity
            return {} as Partial<T>;
        }

        // A real source might use the 'days' array to filter graphQL parameters here
        // For the mock, we just return the static mock slice.
        return { ...data };
    }
}
