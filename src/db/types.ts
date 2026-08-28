/**
 * Database abstraction used by the Bitable synchronisation service.
 *
 * The adapters deliberately do not import a database driver.  Drivers are
 * optional peer dependencies and are loaded at runtime by the corresponding
 * adapter.  This keeps the plugin usable when only one database is enabled
 * and also makes the adapters straightforward to test with a fake driver.
 */

/** Canonical database names persisted by the application. */
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite';
/** Input aliases accepted by the factory (normalised before persistence). */
export type DatabaseTypeAlias = DatabaseType | 'postgresql' | 'pg' | 'mysql2' | 'mariadb' | 'sqlite3';
export type NormalizedDatabaseType = 'postgres' | 'mysql' | 'sqlite';
export type DbType = DatabaseType;

export type Primitive = string | number | boolean | bigint | Date | Uint8Array | null | undefined;
export type QueryValue = Primitive | Primitive[];

export interface SslConfig {
  /** Enables TLS. For PostgreSQL this is passed to pg; for MySQL to mysql2. */
  enabled?: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /** Allow adapter-specific TLS options without weakening the public type. */
  [key: string]: unknown;
}

export interface DatabaseConnectionConfig {
  type: DatabaseTypeAlias;
  /** A complete DSN. When supplied it takes precedence over host fields. */
  connectionString?: string;
  /** Alias for connectionString used by some database UIs. */
  dsn?: string;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  dbName?: string;
  user?: string;
  username?: string;
  userName?: string;
  password?: string;
  ssl?: boolean | SslConfig;
  /** SQLite file name. `:memory:` is supported for ephemeral databases. */
  filename?: string;
  filePath?: string;
  path?: string;
  /** Driver-specific options (pool size, timezone, etc.). */
  options?: Record<string, unknown>;
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  };
  /** Reject accidental writes from a read-only synchronisation connection. */
  readOnly?: boolean;
  /** Optional maximum rows returned by convenience reads (unbounded by default). */
  maxRows?: number;
}

export interface NormalizedDatabaseConfig
  extends Omit<DatabaseConnectionConfig, 'type' | 'username' | 'url' | 'path'> {
  type: NormalizedDatabaseType;
  username?: string;
  connectionString?: string;
  filename?: string;
}

export interface QueryField {
  name: string;
  dataType?: string;
  table?: string;
  schema?: string;
  [key: string]: unknown;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  fields?: QueryField[];
  /** Number of rows affected by an INSERT/UPDATE/DELETE, when provided. */
  affectedRows?: number;
  insertId?: string | number | bigint;
}

export interface QueryOptions {
  signal?: AbortSignal;
  /** Driver query timeout in milliseconds, where supported. */
  timeoutMs?: number;
}

export type FilterOperator =
  | '='
  | '!='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'LIKE'
  | 'ILIKE'
  | 'IN'
  | 'NOT IN'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'BETWEEN';

export interface TableFilter {
  column: string;
  operator?: FilterOperator;
  value?: QueryValue | [Primitive, Primitive];
}

export interface OrderBy {
  column: string;
  direction?: 'ASC' | 'DESC' | 'asc' | 'desc';
}

export interface ReadTableOptions {
  schema?: string;
  columns?: string[];
  where?: TableFilter[] | Record<string, QueryValue>;
  orderBy?: OrderBy | OrderBy[];
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface TableInfo {
  schema?: string;
  name: string;
  type?: string;
  comment?: string;
}

export interface ColumnInfo {
  schema?: string;
  table: string;
  name: string;
  dataType?: string;
  nullable?: boolean;
  defaultValue?: unknown;
  ordinalPosition?: number;
  isPrimaryKey?: boolean;
}

export interface DatabaseAdapter {
  readonly type: NormalizedDatabaseType;
  readonly config: Readonly<NormalizedDatabaseConfig>;
  connect(): Promise<void>;
  /** Run a lightweight health probe without exposing driver-specific handles. */
  testConnection(): Promise<DatabaseHealthResult>;
  ping(): Promise<DatabaseHealthResult>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: Primitive[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  execute<T = Record<string, unknown>>(
    sql: string,
    params?: Primitive[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  readTable<T = Record<string, unknown>>(
    table: string,
    options?: ReadTableOptions,
  ): Promise<QueryResult<T>>;
  /** Lists user-visible tables, excluding system tables by default. */
  listTables(schema?: string): Promise<TableInfo[]>;
  getTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<ColumnInfo[]>;
  getTableSchema(table: string, schema?: string): Promise<ColumnInfo[]>;
  /** Yield rows in bounded pages, useful for large Bitable synchronisations. */
  iterateRows<T = Record<string, unknown>>(
    table: string,
    options?: ReadTableOptions & { pageSize?: number },
  ): AsyncGenerator<T[], void, unknown>;
}

export type DatabaseConfig = DatabaseConnectionConfig;
export type RowPage<T = Record<string, unknown>> = T[];

export interface DatabaseHealthResult {
  ok: boolean;
  type: NormalizedDatabaseType;
  latencyMs: number;
}

export interface AdapterDependencies {
  /** Inject a loaded driver/pool/connection (primarily useful for tests). */
  driver?: unknown;
  /** Optional custom module loader, useful in ESM or plugin sandboxes. */
  loadModule?: (name: string) => unknown;
}

export type DatabaseAdapterConstructor = new (
  config: DatabaseConnectionConfig | NormalizedDatabaseConfig,
  dependencies?: AdapterDependencies,
) => DatabaseAdapter;

export function normalizeDatabaseType(type: DatabaseTypeAlias | string): NormalizedDatabaseType {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'postgres' || value === 'postgresql' || value === 'pg') return 'postgres';
  // MariaDB speaks the MySQL wire protocol and is handled by the mysql2
  // adapter. Accept the common product/DSN alias while persisting the
  // canonical `mysql` type.
  if (value === 'mysql' || value === 'mysql2' || value === 'mariadb') return 'mysql';
  if (value === 'sqlite' || value === 'sqlite3') return 'sqlite';
  throw new Error(`Unsupported database type: ${type}`);
}
