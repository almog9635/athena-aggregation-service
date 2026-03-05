export interface IEntity {
    id: string;
    name: string;
    version: number;
}

export interface ITimeDependentEntity extends IEntity {
    days: string[];
}
