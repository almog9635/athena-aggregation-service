import type { IEntity, ITimeDependentEntity } from '../interfaces/entity.interface';

export function ensureEntityContract<T extends IEntity>(entity: T, name: string, id: string, days?: string[]): void {
    if (!entity.name) {
        entity.name = name;
    }

    if (!entity.id) {
        entity.id = id;
    }

    if (!entity.version) {
        entity.version = 1;
    }

    if (days && days.length > 0) {
        (entity as unknown as ITimeDependentEntity).days = days;
    }
}

export function processFetchedFragments<T extends IEntity>(fragments: Partial<T>[], days?: string[]): Map<string, T[]> {
    const entityMapByName = new Map<string, Map<string, Partial<T>>>();

    for (const fragment of fragments) {
        if (fragment?.id && fragment?.name) {
            let idMap: Map<string, Partial<T>> | undefined = entityMapByName.get(fragment.name);

            if (!idMap) {
                idMap = new Map();
                entityMapByName.set(fragment.name, idMap);
            }

            idMap.set(fragment.id, fragment);
        }
    }

    const completelyMerged = new Map<string, T[]>();

    for (const [name, idMap] of entityMapByName.entries()) {
        const mergedList: T[] = [];

        for (const [id, fragment] of idMap.entries()) {
            const completeEntity = fragment as T;
            ensureEntityContract(completeEntity, name, id, days);
            mergedList.push(completeEntity);
        }
        
        completelyMerged.set(name, mergedList);
    }

    return completelyMerged;
}
