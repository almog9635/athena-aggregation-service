export interface TimeRangeBounds {
    validStartMs: number;
    validEndMs: number;
    msPerDay: number;
}

export function getConfiguredTimeBounds(timeRange?: { pastDays: number, futureDays: number }): TimeRangeBounds | null {
    if (!timeRange) {
        return null;
    }

    const now = new Date();
    // Use UTC for "Start of day" to ensure consistent behavior across environments
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const msPerDay = 1000 * 60 * 60 * 24;

    const { pastDays, futureDays } = timeRange;
    const validStartMs = startOfToday - (pastDays * msPerDay);
    const validEndMs = startOfToday + (futureDays * msPerDay);

    return { validStartMs, validEndMs, msPerDay };
}

export function getConfiguredDays(timeRange?: { pastDays: number, futureDays: number }): string[] {
    const bounds = getConfiguredTimeBounds(timeRange);
    if (!bounds) return [];
    
    const { validStartMs, validEndMs, msPerDay } = bounds;
    const days: string[] = [];
    
    for (let t = validStartMs; t <= validEndMs; t += msPerDay) {
        const date = new Date(t);
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        days.push(`${yyyy}-${mm}-${dd}`);
    }
    
    return days.sort((a, b) => a.localeCompare(b));
}

export function getUnionOfConfiguredDays(config: { 
    pollingTimeRange?: { pastDays: number, futureDays: number },
    dataGroupMapping?: Record<string, any[]>
}): string[] {
    const allRequiredDays = new Set<string>();

    if (config.pollingTimeRange) {
        getConfiguredDays(config.pollingTimeRange).forEach(d => allRequiredDays.add(d));
    }

    if (config.dataGroupMapping) {
        for (const groups of Object.values(config.dataGroupMapping)) {
            for (const group of groups) {
                getConfiguredDays(group.defaultTimeRange).forEach(d => allRequiredDays.add(d));
            }
        }
    }

    return Array.from(allRequiredDays).sort((a, b) => a.localeCompare(b));
}

export function isInsideConfigRange(days: string[], timeRange?: { pastDays: number, futureDays: number }): boolean {
    const bounds = getConfiguredTimeBounds(timeRange);

    if (!bounds) {
        return false;
    }

    const { validStartMs, validEndMs } = bounds;

    for (const day of days) {
        // Assume ISO strings are UTC midnight when comparing
        const date = new Date(`${day}T00:00:00Z`);

        if (Number.isNaN(date.getTime())) {
            return false;
        }

        const time = date.getTime();

        if (time < validStartMs || time > validEndMs) {
            return false;
        }
    }
    return true;
}
