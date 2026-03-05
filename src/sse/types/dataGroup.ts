
export const dataGroup = {
    day: 'day',
    week: 'week',
    month: 'month',
    quarter: 'quarter',
    eventA: 'eventA',
    eventB: 'eventB'
}

export type DataGroup = typeof dataGroup[keyof typeof dataGroup];   