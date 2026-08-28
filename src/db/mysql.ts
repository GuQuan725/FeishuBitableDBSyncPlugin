import { BaseDatabaseAdapter } from './base.js';
import { DatabaseDependencyError, DatabaseQueryError } from './errors.js';
import { callNodeStyle, isPromiseLike, loadOptionalModule, normalizeQueryResponse, unwrapDefault } from './runtime.js';
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

/** MySQL/MariaDB adapter backed by the optional `mysql2` package. */
export class MySQLAdapter extends BaseDatabaseAdapter {
  readonly type = 'mysql' as const;
  private pool: AnyRecord | undefined;
  private ownPool = false;

  constructor(config: DatabaseConnectionConfig | NormalizedDatabaseConfig, dependencies: AdapterDependencies = {}) {
    super(normalizeConnectionConfig(config as DatabaseConnectionConfig), dependencies);
  }

  protected async openConnection(): Promise<void> {
    if (this.pool) return;
    const injected = this.dependencies.driver as AnyRecord | undefined;
    if (injected && isQueryable(injected)) {
      this.pool = injected;
    } else if (injected) {
      const driver = unwrapDefault<AnyRecord>(injected);
      this.pool = await createPool(driver, this.driverOptions(), this.config.connectionString);
      this.ownPool = true;
    } else {
      let driver: AnyRecord;
      try {
        driver = unwrapDefault<AnyRecord>(loadOptionalModule('mysql2/promise', this.dependencies));
      } catch {
        driver = unwrapDefault<AnyRecord>(loadOptionalModule('mysql2', this.dependencies));
      }
      this.pool = await createPool(driver, this.driverOptions(), this.config.connectionString);
      this.ownPool = true;
    }
    if (!this.pool || typeof this.pool.query !== 'function') {
      throw new DatabaseDependencyError('mysql2 (Pool with query method)');
    }
    await this.runQuery('SELECT 1', []);
  }

  protected async closeConnection(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (!pool || !this.ownPool) return;
    const close = pool.end ?? pool.close;
    if (typeof close === 'function') await callNodeStyle<void>(close.bind(pool), []);
    this.ownPool = false;
  }

  protected async runQuery<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[],
    _options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    if (!this.pool) throw new DatabaseQueryError('MySQL adapter is not connected.');
    const raw = await invokeQuery(this.pool, sql, params);
    const result = normalizeQueryResponse<T>(raw);
    if (Array.isArray(raw) && raw.length >= 2 && Array.isArray(raw[1])) {
      result.fields = raw[1].map((field: AnyRecord | string) =>
        typeof field === 'string' ? { name: field } : {
          ...field,
          name: String(field.name ?? field.orgName ?? field.columnName ?? ''),
          dataType: field.type == null ? undefined : String(field.type),
        },
      );
    }
    const metadata = Array.isArray(raw) ? raw[0] : raw;
    if (metadata && typeof metadata === 'object') {
      const source = metadata as AnyRecord;
      if (typeof source.affectedRows === 'number') {
        result.affectedRows = source.affectedRows;
        result.rowCount = source.affectedRows;
      }
      if (source.insertId !== undefined) result.insertId = source.insertId;
    }
    return result;
  }

  protected async fetchTables(schema?: string): Promise<TableInfo[]> {
    const params: Primitive[] = [];
    let sql = `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`\n` +
      `FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`;
    if (schema) {
      sql += ' AND TABLE_SCHEMA = ?';
      params.push(schema);
    } else if (this.config.database) {
      sql += ' AND TABLE_SCHEMA = ?';
      params.push(this.config.database);
    } else {
      sql += ' AND TABLE_SCHEMA NOT IN (?, ?, ?)';
      params.push('information_schema', 'mysql', 'performance_schema');
    }
    sql += ' ORDER BY TABLE_SCHEMA, TABLE_NAME';
    const result = await this.query<TableInfo>(sql, params);
    return result.rows.map((row: AnyRecord) => ({
      schema: String(row.schema ?? row.TABLE_SCHEMA ?? ''),
      name: String(row.name ?? row.TABLE_NAME ?? ''),
      type: row.type == null ? undefined : String(row.type ?? row.TABLE_TYPE),
    }));
  }

  protected async fetchColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const tableName = table.includes('.') ? table.split('.')[1] : table;
    const schemaName = schema ?? (table.includes('.') ? table.split('.')[0] : this.config.database);
    if (!schemaName) throw new DatabaseQueryError('MySQL table description requires a database/schema.');
    const sql = `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS \`name\`,\n` +
      `DATA_TYPE AS \`dataType\`, IS_NULLABLE AS \`isNullable\`, COLUMN_DEFAULT AS \`defaultValue\`,\n` +
      `ORDINAL_POSITION AS \`ordinalPosition\`, (COLUMN_KEY = 'PRI') AS \`isPrimaryKey\`\n` +
      `FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`;
    const result = await this.query<AnyRecord>(sql, [schemaName, tableName]);
    return result.rows.map((row) => ({
      schema: String(row.schema ?? row.TABLE_SCHEMA ?? schemaName),
      table: String(row.table ?? row.TABLE_NAME ?? tableName),
      name: String(row.name ?? row.COLUMN_NAME ?? ''),
      dataType: row.dataType == null ? undefined : String(row.dataType),
      nullable: row.isNullable == null ? undefined : String(row.isNullable).toUpperCase() === 'YES',
      defaultValue: row.defaultValue,
      ordinalPosition: numberOrUndefined(row.ordinalPosition),
      isPrimaryKey: row.isPrimaryKey === true || row.isPrimaryKey === 1 || row.isPrimaryKey === '1',
    }));
  }

  private driverOptions(): AnyRecord {
    const options: AnyRecord = {
      ...(this.config.options ?? {}),
      ...(this.config.host ? { host: this.config.host } : {}),
      ...(this.config.port ? { port: this.config.port } : {}),
      ...(this.config.database ? { database: this.config.database } : {}),
      ...(this.config.user ? { user: this.config.user } : {}),
      ...(this.config.password !== undefined ? { password: this.config.password } : {}),
    };
    if (this.config.ssl !== undefined) {
      if (this.config.ssl === false) options.ssl = false;
      else if (this.config.ssl === true) options.ssl = {};
      else {
        const { enabled: _enabled, ...tls } = this.config.ssl;
        options.ssl = this.config.ssl.enabled === false ? undefined : tls;
      }
    }
    if (this.config.pool?.min !== undefined) options.min = this.config.pool.min;
    if (this.config.pool?.max !== undefined) options.connectionLimit = this.config.pool.max;
    if (this.config.pool?.idleTimeoutMillis !== undefined) options.idleTimeout = this.config.pool.idleTimeoutMillis;
    if (this.config.pool?.connectionTimeoutMillis !== undefined) options.connectTimeout = this.config.pool.connectionTimeoutMillis;
    return options;
  }
}

export const MysqlAdapter = MySQLAdapter;
export const MySQLDatabaseAdapter = MySQLAdapter;

async function createPool(driver: AnyRecord, options: AnyRecord, connectionString?: string): Promise<AnyRecord> {
  if (typeof driver.createPool !== 'function' && typeof driver.createConnection !== 'function') {
    throw new DatabaseDependencyError('mysql2 (createPool/createConnection)');
  }
  // mysql2 accepts a DSN directly. Passing host/password alongside a DSN can
  // produce surprising precedence rules, so preserve the explicit DSN path.
  const argument = connectionString ?? options;
  const pool = typeof driver.createPool === 'function'
    ? driver.createPool(argument)
    : driver.createConnection(argument);
  const resolvedPool = isPromiseLike(pool) ? await pool : pool;
  // mysql2's regular API exposes `.promise()`; use it when available so the
  // rest of the adapter has one predictable async interface.
  if (resolvedPool && typeof resolvedPool.promise === 'function') return resolvedPool.promise();
  return resolvedPool;
}

async function invokeQuery(pool: AnyRecord, sql: string, params: Primitive[]): Promise<unknown> {
  const query = pool.query as (...args: unknown[]) => unknown;
  if (typeof query !== 'function') throw new DatabaseQueryError('MySQL pool does not expose query().');

  // mysql2/promise's PromisePool deliberately rejects a callback argument.
  // Detect the concrete promise wrapper first, then classify injected clients
  // from their function signature. In particular, do not probe a promise
  // client with a callback: a few clients execute the query before returning a
  // rejected promise, and retrying would execute the statement twice.
  if (isPromisePool(pool)) return await query.call(pool, sql, params);

  const signature = classifyQuerySignature(query);
  if (signature === 'callback-params') {
    try {
      return await invokeCallbackQuery(query, pool, [sql, params]);
    } catch (error) {
      throw unwrapInvocationError(error);
    }
  }
  if (signature === 'callback-short') {
    // A `(sql, callback)` API has no positional slot for values. It is useful
    // for the no-parameter health probe and for simple injected fakes; callers
    // that need values should provide the normal `(sql, params, callback)`
    // shape (or a promise-style client).
    try {
      return await invokeCallbackQuery(query, pool, [sql]);
    } catch (error) {
      throw unwrapInvocationError(error);
    }
  }
  if (signature === 'promise') {
    // Promise-style clients receive exactly the two documented arguments. Do
    // not append a callback, even when the values array is empty.
    return await query.call(pool, sql, params);
  }

  // Rest-parameter fakes have no useful Function#length. Prefer the common
  // callback form, then try the short callback form only after a synchronous
  // argument-shape failure. A strict promise rest fake usually reports an
  // arity/callback error synchronously; in that case go directly to the
  // promise form. Never retry an asynchronous rejection, which may represent
  // a query that has already been sent to the server.
  return await invokeRestQuery(query, pool, sql, params);
}

type QuerySignature = 'promise' | 'callback-short' | 'callback-params' | 'rest';

function classifyQuerySignature(query: (...args: unknown[]) => unknown): QuerySignature {
  if (query.length === 0) {
    // Rest wrappers are inherently ambiguous. Prefer a promise call when the
    // implementation advertises async/Promise semantics or explicitly checks
    // the values-array arity. This avoids sending a callback to strict
    // promise fakes (and to mysql2 promise wrappers hidden behind a wrapper),
    // while retaining callback-first compatibility for opaque/rest drivers.
    return looksLikePromiseRestQuery(query) ? 'promise' : 'rest';
  }
  const callbackIndex = callbackParameterIndex(query);
  if (callbackIndex !== undefined) return callbackIndex <= 1 ? 'callback-short' : 'callback-params';
  // A regular callback driver normally exposes `(sql, params, callback)`;
  // retain this arity fallback for minified/wrapped functions whose source no
  // longer contains a recognisable callback parameter name.
  if (query.length >= 3) return 'callback-params';
  return 'promise';
}

function looksLikePromiseRestQuery(query: (...args: unknown[]) => unknown): boolean {
  const source = functionSource(query);
  if (!source || looksLikeCallbackRestQuery(source)) return false;
  if (/\bPromise\s*\./.test(source) || /^\s*async\b/.test(source)) return true;
  // Strict fakes commonly validate `args.length`/`arguments.length` and then
  // return a value. A callback fake that indexes its rest arguments is caught
  // by looksLikeCallbackRestQuery above.
  return /\b(?:args|arguments)\s*(?:\.\s*length|\[\s*['"]length['"]\s*\])\s*(?:!==|===|!=|==|<|>)/.test(source);
}

function looksLikeCallbackRestQuery(source: string): boolean {
  if (/\b(?:callback|cb|done|next|handler|finish|completion)\s*(?:\(|\.\s*(?:call|apply)\s*\()/.test(source)) {
    return true;
  }
  // Common rest fakes pull the callback from the final argument or a fixed
  // callback slot and invoke it. Keep this deliberately narrow so ordinary
  // `args.length` checks in promise clients are not misclassified.
  if (/\b(?:args|arguments)\s*\[[^\]]+\]\s*\(/.test(source)) return true;
  if (/\b(?:args|arguments)\b[\s\S]{0,120}(?:\.\s*at\s*\(\s*-1\s*\)|length\s*-\s*1)[\s\S]{0,80}(?:\(|\.\s*(?:call|apply)\s*\()/.test(source)) {
    return true;
  }
  return false;
}

async function invokeRestQuery(
  query: (...args: unknown[]) => unknown,
  pool: AnyRecord,
  sql: string,
  params: Primitive[],
): Promise<unknown> {
  try {
    return await invokeCallbackQuery(query, pool, [sql, params]);
  } catch (error) {
    if (!isSyncShapeError(error)) throw unwrapInvocationError(error);

    // Errors mentioning arity/argument count are characteristic of strict
    // promise fakes. Calling the short callback form would pass a function as
    // the values argument, so use the promise form directly.
    if (isArityShapeError(error)) return await query.call(pool, sql, params);

    try {
      return await invokeCallbackQuery(query, pool, [sql]);
    } catch (shortError) {
      if (!isSyncShapeError(shortError)) throw unwrapInvocationError(shortError);
      return await query.call(pool, sql, params);
    }
  }
}

/** Determine whether an injected client is mysql2's concrete Promise wrapper. */
function isPromisePool(pool: AnyRecord): boolean {
  const names = [
    pool?.constructor?.name,
    pool?.pool?.constructor?.name,
  ].filter((value): value is string => typeof value === 'string');
  return names.some((name) => /^Promise(?:Pool|Connection|PoolConnection)$/i.test(name));
}

/** Invoke a callback-style query and normalise its callback result. */
async function invokeCallbackQuery(
  query: (...args: unknown[]) => unknown,
  pool: AnyRecord,
  args: unknown[],
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const callback = (error: unknown, rows: unknown, fields: unknown): void => {
      if (error) finish(error);
      else finish(undefined, [rows, fields]);
    };
    try {
      const direct = query.call(pool, ...args, callback);
      if (isPromiseLike(direct)) {
        direct.then((value: unknown) => finish(undefined, value), (error: unknown) => finish(error));
      } else if (direct !== undefined && looksLikeQueryResponse(direct)) {
        finish(undefined, direct);
      }
    } catch (error) {
      finish(new SyncInvocationError(error));
    }
  });
}

class SyncInvocationError extends Error {
  constructor(readonly original: unknown) {
    super('Database query invocation failed before execution.');
    this.name = 'SyncInvocationError';
  }
}

function isSyncInvocationError(error: unknown): error is SyncInvocationError {
  return error instanceof SyncInvocationError;
}

function unwrapInvocationError(error: unknown): unknown {
  return isSyncInvocationError(error) ? error.original : error;
}

/** Find a callback parameter in a normal (non-rest) query function. */
function callbackParameterIndex(query: (...args: unknown[]) => unknown): number | undefined {
  const source = functionSource(query);
  const parameters = extractParameters(source);
  if (parameters.length < 2) return undefined;
  const bodyStart = source.indexOf('=>') >= 0
    ? source.indexOf('=>') + 2
    : source.indexOf('{') >= 0 ? source.indexOf('{') + 1 : source.indexOf(')') + 1;
  const body = source.slice(bodyStart);
  for (let index = 1; index < parameters.length; index += 1) {
    const bare = parameters[index].replace(/^\.\.\./, '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(bare)) continue;
    if (/^(?:cb|callback|done|next|complete|completion|handler|finish)$/i.test(bare)) return index;
    // Also recognise a non-standard parameter name when the function invokes
    // it as a function. This keeps wrappers with names such as `finish`
    // compatible without treating ordinary `params` values as callbacks.
    if (new RegExp(`\\b${escapeRegExp(bare)}\\s*\\(`).test(body)) return index;
  }
  return undefined;
}

function functionSource(query: (...args: unknown[]) => unknown): string {
  try {
    return Function.prototype.toString.call(query);
  } catch {
    return '';
  }
}

function extractParameters(source: string): string[] {
  if (!source) return [];
  const arrow = source.indexOf('=>');
  let text: string;
  if (arrow >= 0) {
    text = source.slice(0, arrow).replace(/^\s*async\s*/, '').trim();
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
  } else {
    const open = source.indexOf('(');
    const close = open >= 0 ? source.indexOf(')', open + 1) : -1;
    if (open < 0 || close < 0) return [];
    text = source.slice(open + 1, close);
  }
  return text.split(',').map((part) => part.trim().replace(/=.*$/, '').trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeQueryResponse(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return Array.isArray(object.rows) || Array.isArray(object[0]) ||
    object.affectedRows !== undefined || object.insertId !== undefined;
}

function isSyncShapeError(error: unknown): error is SyncInvocationError {
  if (!isSyncInvocationError(error)) return false;
  const original = error.original;
  const message = original instanceof Error ? original.message : String(original ?? '');
  // Keep this narrow: a synchronous database error must not be mistaken for
  // an argument-shape error and retried, since the first call may already have
  // reached the server. These are the errors emitted by strict promise fakes,
  // callback wrappers, and mysql2 when a callback is passed to a promise pool.
  return /(?:callback\s+function\s+is\s+not\s+available|callback\s+is\s+not\s+a\s+function|callback\s+not\s+allowed|not\s+a\s+function|expected\s+\d+\s+arguments?|wrong\s+(?:number|count)\s+of\s+arguments?|invalid\s+(?:argument|parameter)|strict\s+arity|arity\s+error)/i.test(message);
}

function isArityShapeError(error: unknown): error is SyncInvocationError {
  if (!isSyncShapeError(error)) return false;
  const original = error.original;
  const message = original instanceof Error ? original.message : String(original ?? '');
  return /arity|argument(?:s)?\s*(?:count|number|length)|expected\s+\d+\s+arguments|strict/i.test(message);
}

function isQueryable(value: AnyRecord): boolean {
  return !!value && typeof value.query === 'function';
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
