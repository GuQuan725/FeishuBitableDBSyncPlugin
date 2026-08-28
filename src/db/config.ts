/** Database-specific configuration entry point. */
export {
  normalizeConnectionConfig,
  redactConnectionConfig,
} from './security.js';
export type {
  DatabaseConfig,
  DatabaseConnectionConfig,
  DatabaseType,
  DatabaseTypeAlias,
  NormalizedDatabaseConfig,
  NormalizedDatabaseType,
  SslConfig,
} from './types.js';

