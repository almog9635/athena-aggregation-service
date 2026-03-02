export interface IEntity {
    name: string;
    version: number;
}

export interface ITimeDependentEntity extends IEntity {
    days: string[];
}
