export enum CacheLogMessage {
    NEW_AGGREGATION = 'New aggregation',
    REUSING_PENDING_PROMISE = 'Reusing pending promise',
    GRAPHQL_INTROSPECTING = 'Introspecting remote schema:',
    GRAPHQL_INTROSPECTED_SUCCESS = 'Successfully introspected:',
    GRAPHQL_FETCH_ALL_WARN = 'fetchAll is not natively generic in Stitched GraphQL mapping. Falling back to empty array.'
}
