/**
 * Deeply merges multiple entity fragments (partial objects) into a single object.
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
 * 
 * @param onIdRemoved A callback triggered when a relational pointer (object with __typename and id) is removed from an array.
 */
export function mergeChanges<T>(target: T, source: T, onIdRemoved?: (typename: string, id: string) => void): void {
    if (!target || !source) return;

    for (const key of Object.keys(source as object) as Array<keyof T>) {
        const sVal = source[key];
        const tVal = target[key];

        // If explicitly identical by reference or primitive value, do nothing
        if (sVal === tVal) continue;

        if (Array.isArray(sVal)) {
            // Only overwrite if it's literally a different array (length mismatch, or item mismatch)
            let isDifferent = false;

            if (!Array.isArray(tVal) || sVal.length !== tVal.length) {
                isDifferent = true;
            } else {
                for (let i = 0; i < sVal.length; i++) {
                    // For arrays, we just do a shallow check against each item.
                    // If you have deeply nested arrays of objects, you might want to recurse here too, 
                    // but usually replacing the array is safer if *any* sub-item changed.
                    if (sVal[i] !== tVal[i]) {
                        isDifferent = true;
                        break;
                    }
                }
            }

            if (isDifferent) {
                // If onIdRemoved is provided, find any objects with {__typename, id} in tVal that are missing from sVal
                if (onIdRemoved && Array.isArray(tVal)) {
                    for (const oldItem of tVal) {
                        if (oldItem && typeof oldItem === 'object' && oldItem.__typename && oldItem.id) {
                            const stillExists = sVal.find(newItem => newItem && newItem.id === oldItem.id);
                            if (!stillExists) {
                                onIdRemoved(oldItem.__typename as string, oldItem.id as string);
                            }
                        }
                    }
                }
                target[key] = sVal;
            }

        } else if (sVal && typeof sVal === 'object' && !(sVal instanceof Date)) {
            // Recursively merge objects
            if (tVal && typeof tVal === 'object' && !(tVal instanceof Date) && !Array.isArray(tVal)) {
                mergeChanges(tVal as any, sVal as any, onIdRemoved);
            } else {
                target[key] = sVal;
            }
        } else {
            // Primitives and dates overwrite
            target[key] = sVal;
        }
    }
}
