import { IEntity } from './entity.interface';

export interface IDataSource<T extends IEntity> {
    fetch(name: string, days?: string[]): Promise<Partial<T>>;
}
