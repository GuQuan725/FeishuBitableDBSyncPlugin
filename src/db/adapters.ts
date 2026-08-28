/** Compatibility entry point for hosts that prefer importing adapters only. */
export { PostgresAdapter, PostgreSQLAdapter, PostgresDatabaseAdapter, PostgreSQLDatabaseAdapter } from './postgres.js';
export { MySQLAdapter, MysqlAdapter, MySQLDatabaseAdapter } from './mysql.js';
export { SQLiteAdapter, SqliteAdapter, SQLiteDatabaseAdapter } from './sqlite.js';
export { createAdapter, createDbAdapter, createDatabaseAdapter, getDatabaseAdapter, connectDatabase } from './factory.js';
export type {
  AdapterDependencies,
  DatabaseAdapter,
  DatabaseConnectionConfig,
  DatabaseType,
  DatabaseTypeAlias,
  NormalizedDatabaseConfig,
  NormalizedDatabaseType,
  QueryOptions,
  QueryResult,
  ReadTableOptions,
  TableInfo,
  ColumnInfo,
  DatabaseHealthResult,
} from './types.js';
