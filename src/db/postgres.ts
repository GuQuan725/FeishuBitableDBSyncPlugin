import { BaseDatabaseAdapter } from './base.js';
import { DatabaseDependencyError, DatabaseQueryError } from './errors.js';
import { loadOptionalModule, normalizeQueryResponse, unwrapDefault, callNodeStyle } from './runtime.js';
import {
  AdapterDependencies,
  ColumnInfo,
  DatabaseConnectionConfig,
  NormalizedDatabaseConfig,
  Primitive,
  QueryOptions,
  QueryResult,
  TableInfo,
} from './types.js';
import { normalizeConnectionConfig } from './security.js';

type AnyRecord = Record<string, any>;

/** PostgreSQL adapter backed by the optional `pg` package. */
export class PostgresAdapter extends BaseDatabaseAdapter {
  readonly type = 'postgres' as const;
  private pool: AnyRecord | undefined;
  private ownPool = false;

  constructor(config: DatabaseConnectionConfig | NormalizedDatabaseConfig, dependencies: AdapterDependencies = {}) {
    super(normalizeConnectionConfig(config as DatabaseConnectionConfig), dependencies);
  }

  protected async openConnection(): Promise<void> {
    if (this.pool) return;
    const injected = this.dependencies.driver as AnyRecord | undefined;
    let driver: AnyRecord;
    if (injected) {
      driver = unwrapDefault<AnyRecord>(injected);
      if (driver && isQueryable(driver.pool)) {
        this.pool = driver.pool;
      } else {
        // An injected pg module exposes Pool; instantiate it just like the
        // runtime package. An already-created pool/client is used as-is.
        if (typeof driver === 'function') {
          this.pool = new (driver as any)(this.driverOptions());
          this.ownPool = true;
        } else if (typeof driver.Pool === 'function' && !isQueryable(driver)) {
          this.pool = new (driver.Pool as any)(this.driverOptions());
          this.ownPool = true;
        } else if (typeof driver.Client === 'function' && !isQueryable(driver)) {
          const client = new (driver.Client as any)(this.driverOptions());
          this.pool = client;
          this.ownPool = true;
          if (typeof client.connect === 'function') {
            await callNodeStyle<void>(client.connect.bind(client), []);
          }
        } else {
          this.pool = driver;
        }
      }
    } else {
      driver = unwrapDefault<AnyRecord>(loadOptionalModule('pg', this.dependencies));
      if (typeof driver.Pool === 'function') {
        this.pool = new (driver.Pool as any)(this.driverOptions());
        this.ownPool = true;
      } else if (typeof driver.Client === 'function') {
        const client = new (driver.Client as any)(this.driverOptions());
        this.pool = client;
        this.ownPool = true;
        if (typeof client.connect === 'function') {
          await callNodeStyle<void>(client.connect.bind(client), []);
        }
      } else {
        throw new DatabaseDependencyError('pg (Pool or Client)');
      }
    }
    if (!this.pool || typeof this.pool.query !== 'function') {
      throw new DatabaseDependencyError('pg (Pool with query method)');
    }
    // Establish the connection eagerly so misconfiguration is reported during
    // connect(), rather than on the first synchronisation page.
    await this.runQuery('SELECT 1', []);
  }

  protected async closeConnection(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (!pool || !this.ownPool || typeof pool.end !== 'function') return;
    await callNodeStyle<void>(pool.end.bind(pool), []);
    this.ownPool = false;
  }

  protected async runQuery<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[],
    _options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    if (!this.pool) throw new DatabaseQueryError('PostgreSQL adapter is not connected.');
    const raw = await callNodeStyle<AnyRecord>(this.pool.query.bind(this.pool), [sql, params]);
    const result = normalizeQueryResponse<T>(raw);
    // pg returns fields with dataTypeID; preserve useful metadata.
    if (raw && typeof raw === 'object' && Array.isArray((raw as AnyRecord).fields)) {
      result.fields = (raw as AnyRecord).fields.map((field: AnyRecord) => ({
        ...field,
        name: String(field.name ?? ''),
        dataType: field.dataType ?? (field.dataTypeID != null ? String(field.dataTypeID) : undefined),
      }));
    }
    if (raw && typeof raw === 'object' && typeof (raw as AnyRecord).rowCount === 'number') {
      result.rowCount = (raw as AnyRecord).rowCount;
    }
    return result;
  }

  protected async fetchTables(schema?: string): Promise<TableInfo[]> {
    const params: Primitive[] = [];
    let sql = `SELECT table_schema AS "schema", table_name AS "name", table_type AS "type"\n` +
      `FROM information_schema.tables WHERE table_type = 'BASE TABLE'`;
    if (schema) {
      sql += ' AND table_schema = $1';
      params.push(schema);
    } else {
      sql += " AND table_schema NOT IN ('pg_catalog', 'information_schema')";
    }
    sql += ' ORDER BY table_schema, table_name';
    const result = await this.query<TableInfo>(sql, params);
    return result.rows.map((row: AnyRecord) => ({
      schema: String(row.schema ?? row.table_schema ?? ''),
      name: String(row.name ?? row.table_name ?? ''),
      type: row.type == null ? undefined : String(row.type),
    }));
  }

  protected async fetchColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const tableName = table.includes('.') ? table.split('.')[1] : table;
    const schemaName = schema ?? (table.includes('.') ? table.split('.')[0] : 'public');
    const sql = `SELECT c.table_schema AS "schema", c.table_name AS "table", c.column_name AS "name",\n` +
      `c.data_type AS "dataType", c.is_nullable AS "isNullable", c.column_default AS "defaultValue",\n` +
      `c.ordinal_position AS "ordinalPosition",\n` +
      `CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS "isPrimaryKey"\n` +
      `FROM information_schema.columns c\n` +
      `LEFT JOIN information_schema.key_column_usage k ON k.table_schema = c.table_schema\n` +
      ` AND k.table_name = c.table_name AND k.column_name = c.column_name\n` +
      `LEFT JOIN information_schema.table_constraints tc ON tc.constraint_schema = k.constraint_schema\n` +
      ` AND tc.constraint_name = k.constraint_name AND tc.constraint_type = 'PRIMARY KEY'\n` +
      `WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`;
    const result = await this.query<AnyRecord>(sql, [schemaName, tableName]);
    return result.rows.map((row) => ({
      schema: String(row.schema ?? ''),
      table: String(row.table ?? tableName),
      name: String(row.name ?? ''),
      dataType: row.dataType == null ? undefined : String(row.dataType),
      nullable: row.isNullable == null ? undefined : String(row.isNullable).toUpperCase() === 'YES',
      defaultValue: row.defaultValue,
      ordinalPosition: numberOrUndefined(row.ordinalPosition),
      isPrimaryKey: row.isPrimaryKey === true || row.isPrimaryKey === 't' || row.isPrimaryKey === 1,
    }));
  }

  private driverOptions(): AnyRecord {
    const ssl = this.config.ssl;
    const options: AnyRecord = { ...(this.config.options ?? {}) };
    if (this.config.connectionString) options.connectionString = this.config.connectionString;
    else {
      if (this.config.host) options.host = this.config.host;
      if (this.config.port) options.port = this.config.port;
      if (this.config.database) options.database = this.config.database;
      if (this.config.user) options.user = this.config.user;
      if (this.config.password !== undefined) options.password = this.config.password;
    }
    if (ssl !== undefined) {
      if (ssl === false) options.ssl = false;
      else if (ssl === true) options.ssl = { rejectUnauthorized: true };
      else {
        const { enabled: _enabled, ...tls } = ssl;
        options.ssl = ssl.enabled === false ? false : tls;
      }
    }
    if (this.config.pool?.max !== undefined) options.max = this.config.pool.max;
    if (this.config.pool?.min !== undefined) options.min = this.config.pool.min;
    if (this.config.pool?.idleTimeoutMillis !== undefined) options.idleTimeoutMillis = this.config.pool.idleTimeoutMillis;
    if (this.config.pool?.connectionTimeoutMillis !== undefined) options.connectionTimeoutMillis = this.config.pool.connectionTimeoutMillis;
    return options;
  }
}

/** Conventional acronym spelling retained for consumers that prefer it. */
export const PostgreSQLAdapter = PostgresAdapter;
export const PostgresDatabaseAdapter = PostgresAdapter;
export const PostgreSQLDatabaseAdapter = PostgresAdapter;

function isQueryable(value: AnyRecord): boolean {
  return !!value && typeof value.query === 'function';
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
