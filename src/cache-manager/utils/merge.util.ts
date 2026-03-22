/**
 * Mutates `target` to update only the fields that are different in `source`.
 * Useful for preserving memory references of nested objects inside the cache
 * when a new version is fetched.
 * 
 * @param onIdRemoved A callback triggered when a relational pointer (object with __typename and id) is removed from an array.
 */
export function mergeChanges<T>(target: T, source: T, onIdRemoved?: (typename: string, id: string) => void): void {
    if (!target || !source) return;

    // Optimization: If both objects are versioned entities, skip deep merging if the new version is not newer.
    if ('version' in (target as any) && 'version' in (source as any)) {
        const targetVersion = (target as any).version;
        const sourceVersion = (source as any).version;
        if (typeof targetVersion === 'number' && typeof sourceVersion === 'number' && sourceVersion <= targetVersion) {
            return;
        }
    }

    (Object.keys(source as object) as Array<keyof T>).forEach(key => {
        const sVal = source[key];
        const tVal = target[key];

        // If explicitly identical by reference or primitive value, do nothing
        if (sVal !== tVal) {
            if (Array.isArray(sVal)) {
                handleArrayChange(target, key, sVal, tVal, onIdRemoved);
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
    });
}

function handleArrayChange<T>(target: T, key: keyof T, sVal: any[], tVal: any, onIdRemoved?: (typename: string, id: string) => void): void {
    // Only overwrite if it's literally a different array (length mismatch, or item mismatch)
    const isDifferent = !Array.isArray(tVal) || sVal.length !== tVal.length || sVal.some((v, i) => v !== tVal[i]);

    if (isDifferent) {
        // If onIdRemoved is provided, find any objects with {__typename, id} in tVal that are missing from sVal
        if (onIdRemoved && Array.isArray(tVal)) {
            tVal.forEach(oldItem => {
                if (oldItem?.__typename && oldItem?.id) {
                    const stillExists = sVal.find(newItem => newItem?.id === oldItem.id);
                    if (!stillExists) {
                        onIdRemoved(oldItem.__typename as string, oldItem.id as string);
                    }
                }
            });
        }
        target[key] = sVal as any;
    }
}
