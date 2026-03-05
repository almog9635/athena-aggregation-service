import { IEntity } from './entity.interface';

export interface IDataSource<T extends IEntity> {
    fetch(name: string, days?: string[]): Promise<Partial<T>[]>;

    // Optional bulk operations
    fetchByIds?(name: string, ids: string[], days?: string[]): Promise<Partial<T>[]>;
    fetchAll?(days?: string[]): Promise<Partial<T>[]>;
}
