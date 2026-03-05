export enum CacheErrorMessage {
    RELEASE_NON_EXISTENT = 'Attempted to release non-existent entity',
    POLLING_ERROR = 'Polling error for',
    GRAPHQL_INTROSPECTION_ERROR = 'Failed to introspect schema',
    GRAPHQL_QUERY_ERROR = 'GraphQL query errors for',
    GRAPHQL_EXECUTION_ERROR = 'Failed to execute dynamic GraphQL query for',
    GRAPHQL_NO_QUERY_TYPE = 'GraphQL stitched schema has no query returning type',
    GRAPHQL_NO_SCHEMA = 'GraphQL stitched schema is not available'
}
