/**
 * Deeply merges multiple partial objects into a single object.
 * Arrays and primitives are overwritten by the rightmost object.
 * Objects are merged recursively.
 */
export function deepMerge<T>(...objects: Partial<T>[]): T {
    const result: any = {};

    for (const obj of objects) {
        if (!obj) continue;

        for (const key of Object.keys(obj)) {
            const pVal = result[key];
            const oVal = (obj as any)[key];

            if (Array.isArray(oVal)) {
                // Overwrite arrays rather than merging them
                result[key] = [...oVal];
            } else if (oVal && typeof oVal === 'object' && !(oVal instanceof Date)) {
                if (pVal && typeof pVal === 'object' && !(pVal instanceof Date) && !Array.isArray(pVal)) {
                    result[key] = deepMerge(pVal, oVal);
                } else {
                    result[key] = deepMerge({}, oVal);
                }
            } else {
                result[key] = oVal;
            }
        }
    }

    return result as T;
}

/**
 * Mutates `target` to update only the fields that are different in `source`.
 * Useful for preserving memory references of nested objects inside the cache
 * when a new version is fetched.
 */
export function mergeChanges<T>(target: T, source: T): void {
    for (const key of Object.keys(source as object) as Array<keyof T>) {
        const sVal = source[key];
        const tVal = target[key];

        // If identical, do nothing
        if (sVal === tVal) continue;

        if (Array.isArray(sVal)) {
            // Overwrite array
            target[key] = sVal;
        } else if (sVal && typeof sVal === 'object' && !(sVal instanceof Date)) {
            if (tVal && typeof tVal === 'object' && !(tVal instanceof Date) && !Array.isArray(tVal)) {
                mergeChanges(tVal as any, sVal as any);
            } else {
                target[key] = sVal;
            }
        } else {
            // Primitives and dates overwrite
            target[key] = sVal;
        }
    }
}
