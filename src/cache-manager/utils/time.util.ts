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
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayOfWeek = new Date(startOfToday).getDay();
    const msPerDay = 1000 * 60 * 60 * 24;

    const startOfWeekMs = startOfToday - (dayOfWeek * msPerDay);
    const endOfWeekMs = startOfWeekMs + (6 * msPerDay);

    const { pastDays, futureDays } = timeRange;
    const validStartMs = startOfWeekMs - (pastDays * msPerDay);
    const validEndMs = endOfWeekMs + (futureDays * msPerDay);

    return { validStartMs, validEndMs, msPerDay };
}

export function getConfiguredDays(timeRange?: { pastDays: number, futureDays: number }): string[] {
    const bounds = getConfiguredTimeBounds(timeRange);
    if (!bounds) return [];
    
    const { validStartMs, validEndMs, msPerDay } = bounds;
    const days: string[] = [];
    
    for (let t = validStartMs; t <= validEndMs; t += msPerDay) {
        const date = new Date(t);
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        days.push(`${yyyy}-${mm}-${dd}`);
    }
    
    return days;
}

export function isInsideConfigRange(days: string[], timeRange?: { pastDays: number, futureDays: number }): boolean {
    const bounds = getConfiguredTimeBounds(timeRange);

    if (!bounds) {
        return false;
    }

    const { validStartMs, validEndMs } = bounds;

    for (const day of days) {
        const date = new Date(day);

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
