export * from './types.js';
export * from './field-mapping.js';
export * from './feishu-client.js';
export * from './sync-service.js';

// Friendly aliases for integrations that use the terms "engine" or
// "bitable client" in their own codebase.
export { BitableSyncService as BitableSyncEngine } from './sync-service.js';
export { syncToBitable as syncRows } from './sync-service.js';
export { mapRow as mapDatabaseRow, mapRows as mapDatabaseRows } from './field-mapping.js';
