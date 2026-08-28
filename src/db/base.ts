import {
  AdapterDependencies,
  ColumnInfo,
  DatabaseAdapter,
  NormalizedDatabaseConfig,
  NormalizedDatabaseType,
  Primitive,
  QueryOptions,
  QueryResult,
  ReadTableOptions,
  TableInfo,
} from './types.js';
import {
  assertSafeSql,
  buildWhereClause,
  normalizeOffset,
  normalizeReadLimit,
  quoteIdentifier,
  quoteIdentifierPath,
} from './security.js';
import {
  DatabaseAdapterError,
  DatabaseQueryError,
  isAbortError,
  normalizeDriverError,
} from './errors.js';
import { DatabaseHealthResult } from './types.js';

/** Common lifecycle, safety, and convenience methods shared by all adapters. */
export abstract class BaseDatabaseAdapter implements DatabaseAdapter {
  abstract readonly type: NormalizedDatabaseType;
  readonly config: Readonly<NormalizedDatabaseConfig>;
  protected readonly dependencies: AdapterDependencies;
  protected connected = false;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;

  protected constructor(config: NormalizedDatabaseConfig, dependencies: AdapterDependencies = {}) {
    this.config = Object.freeze({ ...config, options: config.options ? { ...config.options } : undefined });
    this.dependencies = dependencies;
  }

  protected abstract openConnection(): Promise<void>;
  protected abstract closeConnection(): Promise<void>;
  protected abstract runQuery<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  protected abstract fetchTables(schema?: string): Promise<TableInfo[]>;
  protected abstract fetchColumns(table: string, schema?: string): Promise<ColumnInfo[]>;

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection()
      .then(() => {
        this.connected = true;
      })
      .catch(async (error) => {
        this.connected = false;
        // Adapters may allocate a pool/handle before their probe query fails.
        // Always release that partial resource so a retry starts cleanly.
        try {
          await this.closeConnection();
        } catch {
          // Preserve the original connection error; cleanup is best effort.
        }
        throw error instanceof DatabaseAdapterError ? error : normalizeDriverError(error, 'Could not connect to database.');
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.connected && !this.connecting) return;
    this.closing = (async () => {
      // Wait for an in-flight connection before closing it. If connect failed,
      // there is nothing to close and the original error remains observable.
      if (this.connecting) {
        try {
          await this.connecting;
        } catch {
          this.connected = false;
          return;
        }
      }
      if (this.connected) {
        try {
          await this.closeConnection();
        } finally {
          this.connected = false;
        }
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  async disconnect(): Promise<void> {
    return this.close();
  }

  async testConnection(): Promise<DatabaseHealthResult> {
    const started = Date.now();
    await this.query('SELECT 1', []);
    return { ok: true, type: this.type, latencyMs: Math.max(0, Date.now() - started) };
  }

  async ping(): Promise<DatabaseHealthResult> {
    return this.testConnection();
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    if (options.signal?.aborted) throw abortError();
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new DatabaseQueryError('timeoutMs must be a non-negative finite number.');
    }
    assertSafeSql(sql, this.config.readOnly !== false);
    validateParams(params);
    await this.connect();
    try {
      const result = await withTimeout(
        this.runQuery<T>(sql, params, options),
        options.timeoutMs,
        options.signal,
      );
      if (options.signal?.aborted) throw abortError();
      return normalizeResult(result);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DatabaseAdapterError) throw error;
      throw normalizeDriverError(error);
    }
  }

  async execute<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    return this.query<T>(sql, params, options);
  }

  async readTable<T = Record<string, unknown>>(
    table: string,
    options: ReadTableOptions = {},
  ): Promise<QueryResult<T>> {
    const tableSql = quoteIdentifierPath(table, this.type);
    const schemaPrefix = options.schema ? `${quoteIdentifier(options.schema, this.type)}.` : '';
    // If callers pass schema separately, table must be a single identifier to
    // avoid accidentally constructing a three-part path.
    if (options.schema && table.includes('.')) {
      throw new DatabaseQueryError('Pass either schema-qualified table or schema separately, not both.');
    }
    const columns = options.columns?.length
      ? options.columns.length === 1 && options.columns[0] === '*'
        ? '*'
        : options.columns.map((column) => quoteIdentifier(column, this.type)).join(', ')
      : '*';
    const where = buildWhereClause(options.where, this.type, 1);
    let sql = `SELECT ${columns} FROM ${schemaPrefix}${tableSql}${where.sql}`;
    const order = normalizeOrder(options.orderBy, this.type);
    if (order) sql += ` ORDER BY ${order}`;
    const configuredMax = this.config.maxRows;
    const requestedLimit = normalizeReadLimit(options.limit, 10_000);
    const limit = configuredMax === undefined ? requestedLimit : Math.min(requestedLimit, configuredMax);
    const offset = normalizeOffset(options.offset);
    const limitPlaceholder = this.type === 'postgres' ? `$${where.params.length + 1}` : '?';
    const offsetPlaceholder = this.type === 'postgres' ? `$${where.params.length + 2}` : '?';
    sql += ` LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
    return this.query<T>(sql, [...where.params, limit, offset], { signal: options.signal });
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    await this.connect();
    if (schema !== undefined) quoteIdentifier(schema, this.type);
    try {
      return await this.fetchTables(schema);
    } catch (error) {
      if (error instanceof DatabaseAdapterError) throw error;
      throw normalizeDriverError(error, 'Could not list database tables.');
    }
  }

  async getTables(schema?: string): Promise<TableInfo[]> {
    return this.listTables(schema);
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    quoteIdentifierPath(table, this.type);
    if (schema !== undefined) quoteIdentifier(schema, this.type);
    if (schema && table.includes('.')) throw new DatabaseQueryError('Pass either schema-qualified table or schema separately, not both.');
    await this.connect();
    try {
      return await this.fetchColumns(table, schema);
    } catch (error) {
      if (error instanceof DatabaseAdapterError) throw error;
      throw normalizeDriverError(error, 'Could not describe database table.');
    }
  }

  async getTableSchema(table: string, schema?: string): Promise<ColumnInfo[]> {
    return this.describeTable(table, schema);
  }

  async *iterateRows<T = Record<string, unknown>>(
    table: string,
    options: ReadTableOptions & { pageSize?: number } = {},
  ): AsyncGenerator<T[], void, unknown> {
    const pageSize = normalizeReadLimit(options.pageSize, Math.min(this.config.maxRows ?? 1_000_000, 1_000));
    let offset = normalizeOffset(options.offset);
    const maxRows = this.config.maxRows ?? Number.MAX_SAFE_INTEGER;
    let yielded = 0;
    while (yielded < maxRows) {
      const limit = Math.min(pageSize, maxRows - yielded);
      const result = await this.readTable<T>(table, { ...options, limit, offset });
      if (!result.rows.length) return;
      yield result.rows;
      yielded += result.rows.length;
      offset += result.rows.length;
      if (result.rows.length < limit) return;
    }
  }
}

function validateParams(params: Primitive[]): void {
  if (!Array.isArray(params)) throw new DatabaseQueryError('Query parameters must be an array.');
  for (const value of params) {
    const primitive = value === null || value === undefined ||
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ||
      value instanceof Date || value instanceof Uint8Array;
    if (!primitive) throw new DatabaseQueryError('Query parameters must contain only primitive values.');
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new DatabaseQueryError('Query parameters cannot contain NaN or Infinity.');
    }
    if (typeof value === 'string' && value.length > 10_000_000) {
      throw new DatabaseQueryError('A query parameter is too large.');
    }
    if (value instanceof Date && !Number.isFinite(value.getTime())) {
      throw new DatabaseQueryError('Query parameters cannot contain an invalid date.');
    }
  }
}

function normalizeResult<T>(result: QueryResult<T> | undefined | null): QueryResult<T> {
  if (!result) return { rows: [], rowCount: 0 };
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return {
    ...result,
    rows,
    rowCount: Number.isFinite(result.rowCount) ? result.rowCount : rows.length,
  };
}

function normalizeOrder(
  orderBy: ReadTableOptions['orderBy'],
  dialect: NormalizedDatabaseType,
): string {
  if (!orderBy) return '';
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  return orders
    .map((order) => {
      if (!order || typeof order.column !== 'string') throw new DatabaseQueryError('orderBy.column is required.');
      const direction = String(order.direction ?? 'ASC').toUpperCase();
      if (direction !== 'ASC' && direction !== 'DESC') throw new DatabaseQueryError('orderBy.direction must be ASC or DESC.');
      return `${quoteIdentifier(order.column, dialect)} ${direction}`;
    })
    .join(', ');
}

function abortError(): Error {
  const error = new Error('Database operation aborted.');
  error.name = 'AbortError';
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  if (timeoutMs === undefined && !signal) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = timeoutMs !== undefined
    ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DatabaseQueryError(`Database query timed out after ${timeoutMs} ms.`, { retryable: true });
        reject(error);
      }, timeoutMs);
    })
    : undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
      const handler = () => reject(abortError());
      signal.addEventListener('abort', handler, { once: true });
      removeAbort = () => signal.removeEventListener('abort', handler);
    })
    : undefined;
  try {
    const candidates = [promise];
    if (timeout) candidates.push(timeout);
    if (aborted) candidates.push(aborted);
    return await Promise.race(candidates);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}
