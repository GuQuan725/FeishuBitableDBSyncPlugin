import { BaseDatabaseAdapter } from './base.js';
import { DatabaseDependencyError, DatabaseQueryError, normalizeDriverError } from './errors.js';
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
import { normalizeConnectionConfig, quoteIdentifier, stripSqlLiteralsAndComments } from './security.js';

type AnyRecord = Record<string, any>;

/** SQLite adapter supporting better-sqlite3, sqlite3, and node:sqlite. */
export class SQLiteAdapter extends BaseDatabaseAdapter {
  readonly type = 'sqlite' as const;
  private db: AnyRecord | undefined;
  private driverKind: 'better-sqlite3' | 'sqlite3' | 'node-sqlite' | 'injected' | undefined;
  private ownDb = false;

  constructor(config: DatabaseConnectionConfig | NormalizedDatabaseConfig, dependencies: AdapterDependencies = {}) {
    super(normalizeConnectionConfig(config as DatabaseConnectionConfig), dependencies);
  }

  protected async openConnection(): Promise<void> {
    if (this.db) return;
    const injected = this.dependencies.driver as AnyRecord | undefined;
    if (injected && looksLikeDatabase(injected)) {
      this.db = injected;
      this.driverKind = typeof injected.prepare === 'function'
        ? 'injected'
        : isCallbackSqliteHandle(injected)
          ? 'sqlite3'
          : 'injected';
    } else if (injected) {
      const kind = detectModuleKind(injected);
      if (!kind) throw new DatabaseDependencyError('SQLite driver module');
      const db = instantiate(unwrapDefault<AnyRecord>(injected), this.config.filename!, this.config.readOnly !== false, kind);
      if (!db) throw new DatabaseDependencyError(`SQLite ${kind} driver`);
      this.db = db;
      this.driverKind = kind;
      this.ownDb = true;
      const openPromise = (db as AnyRecord).__openPromise;
      if (openPromise && isPromiseLike(openPromise)) await openPromise;
    } else {
      const candidates = [
        { name: 'better-sqlite3', kind: 'better-sqlite3' as const },
        { name: 'sqlite3', kind: 'sqlite3' as const },
        { name: 'node:sqlite', kind: 'node-sqlite' as const },
      ];
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const module = unwrapDefault<AnyRecord>(
            this.dependencies.driver && candidate.name === 'better-sqlite3'
              ? this.dependencies.driver
              : loadOptionalModule(candidate.name, this.dependencies),
          );
          const db = instantiate(module, this.config.filename!, this.config.readOnly !== false, candidate.kind);
          if (db) {
            this.db = db;
            this.driverKind = candidate.kind;
            this.ownDb = true;
            const openPromise = (db as AnyRecord).__openPromise;
            if (openPromise && isPromiseLike(openPromise)) await openPromise;
            break;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!this.db) {
        if (lastError && !(lastError instanceof DatabaseDependencyError)) {
          throw normalizeDriverError(lastError, 'Could not open SQLite database.');
        }
        throw new DatabaseDependencyError('better-sqlite3, sqlite3, or node:sqlite', lastError);
      }
    }
    if (!looksLikeDatabase(this.db)) throw new DatabaseDependencyError('SQLite database handle');
    // A harmless query verifies the handle and catches invalid paths early.
    await this.runQuery('SELECT 1 AS "ok"', []);
  }

  protected async closeConnection(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    if (!db || !this.ownDb) return;
    const close = db.close;
    if (typeof close === 'function') {
      if (this.driverKind === 'sqlite3') {
        await callNodeStyle<void>(close.bind(db), []);
      } else {
        const result = close.call(db);
        if (isPromiseLike(result)) await result;
      }
    }
    this.ownDb = false;
  }

  protected async runQuery<T = Record<string, unknown>>(
    sql: string,
    params: Primitive[],
    _options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    if (!this.db) throw new DatabaseQueryError('SQLite adapter is not connected.');
    switch (this.driverKind) {
      case 'better-sqlite3':
      case 'node-sqlite':
      case 'injected':
        return await executeSyncLike<T>(this.db, sql, params);
      case 'sqlite3':
        return executeSqlite3<T>(this.db, sql, params);
      default:
        throw new DatabaseQueryError('SQLite adapter has no active driver.');
    }
  }

  protected async fetchTables(schema?: string): Promise<TableInfo[]> {
    // SQLite has no schemas; accept "main" for API consistency.
    if (schema && schema !== 'main' && schema !== 'temp') {
      throw new DatabaseQueryError(`Unknown SQLite schema: ${schema}`);
    }
    const tableSource = schema === 'temp' ? 'sqlite_temp_master' : 'sqlite_master';
    const result = await this.query<AnyRecord>(
      `SELECT name AS "name", type AS "type" FROM ${tableSource} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      [],
    );
    return result.rows.map((row) => ({
      schema: schema ?? 'main',
      name: String(row.name ?? ''),
      type: row.type == null ? undefined : String(row.type),
    }));
  }

  protected async fetchColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const tableName = table.includes('.') ? table.split('.')[1] : table;
    const schemaName = schema ?? (table.includes('.') ? table.split('.')[0] : 'main');
    if (schemaName !== 'main' && schemaName !== 'temp') throw new DatabaseQueryError(`Unknown SQLite schema: ${schemaName}`);
    const pragma = schemaName === 'temp' ? 'temp.table_info' : 'table_info';
    // PRAGMA table_info does not accept bound identifiers; quoteIdentifier
    // validates the name and emits a dialect-safe quoted token before we
    // interpolate it. This form also works on older SQLite versions where
    // pragma_table_info() table-valued functions are unavailable.
    const result = await this.query<AnyRecord>(
      `PRAGMA ${pragma}(${quoteIdentifier(tableName, 'sqlite')})`,
      [],
    );
    return result.rows.map((row) => ({
      schema: schemaName,
      table: tableName,
      name: String(row.name ?? ''),
      dataType: row.dataType == null && row.type == null ? undefined : String(row.dataType ?? row.type),
      nullable: !((row.notNull ?? row.notnull) === 1 || (row.notNull ?? row.notnull) === true || String(row.notNull ?? row.notnull) === '1'),
      defaultValue: row.defaultValue ?? row.dflt_value,
      ordinalPosition: numberOrUndefined(row.ordinalPosition ?? row.cid),
      isPrimaryKey: (row.isPrimaryKey ?? row.pk) === true || (row.isPrimaryKey ?? row.pk) === 1 || String(row.isPrimaryKey ?? row.pk) === '1',
    }));
  }
}

export const SqliteAdapter = SQLiteAdapter;
export const SQLiteDatabaseAdapter = SQLiteAdapter;

function instantiate(module: AnyRecord, filename: string, readOnly: boolean, kind: string): AnyRecord | undefined {
  if (!module) return undefined;
  if (kind === 'better-sqlite3') {
    const Ctor = typeof module === 'function' ? module : module.Database;
    if (typeof Ctor !== 'function') return undefined;
    // `:memory:` databases do not exist on disk, so fileMustExist must remain
    // false even when the connection is read-only.
    return new Ctor(filename, { readonly: readOnly, fileMustExist: filename !== ':memory:' && readOnly });
  }
  if (kind === 'sqlite3') {
    const Ctor = module.Database ?? module;
    if (typeof Ctor !== 'function') return undefined;
    const mode = readOnly && filename !== ':memory:' && typeof module.OPEN_READONLY === 'number'
      ? module.OPEN_READONLY
      : undefined;
    // sqlite3 constructor is callback based. Opening is completed before the
    // first query; errors are surfaced by a small promise wrapper.
    let db: AnyRecord;
    let callbackResolve: (() => void) | undefined;
    let callbackReject: ((error: unknown) => void) | undefined;
    const opened = new Promise<void>((resolve, reject) => {
      callbackResolve = resolve;
      callbackReject = reject;
    });
    const callback = (error: unknown) => error ? callbackReject?.(error) : callbackResolve?.();
    db = mode === undefined ? new Ctor(filename, callback) : new Ctor(filename, mode, callback);
    // Attach a promise marker consumed by openConnection below.
    (db as AnyRecord).__openPromise = opened;
    return db;
  }
  if (kind === 'node-sqlite') {
    const Ctor = module.DatabaseSync ?? module.Database;
    if (typeof Ctor !== 'function') return undefined;
    return new Ctor(filename, { readOnly });
  }
  return module;
}

function detectModuleKind(module: AnyRecord): 'better-sqlite3' | 'sqlite3' | 'node-sqlite' | undefined {
  if (typeof module === 'function') return 'better-sqlite3';
  if (module.DatabaseSync) return 'node-sqlite';
  if (module.SqliteError || module.Database?.prototype?.prepare) return 'better-sqlite3';
  if (module.OPEN_READONLY !== undefined || module.verbose || module.Database?.prototype?.all || module.Database?.prototype?.run) return 'sqlite3';
  if (typeof module.Database === 'function') return 'sqlite3';
  return undefined;
}

function looksLikeDatabase(value: AnyRecord | undefined): boolean {
  return !!value && (typeof value.prepare === 'function' || typeof value.all === 'function' || typeof value.run === 'function' || typeof value.exec === 'function');
}

function isCallbackSqliteHandle(value: AnyRecord): boolean {
  return typeof value.serialize === 'function' || typeof value.parallelize === 'function' ||
    (typeof value.all === 'function' && value.all.length >= 3) ||
    (typeof value.run === 'function' && value.run.length >= 3);
}

async function executeSyncLike<T>(db: AnyRecord, sql: string, params: Primitive[]): Promise<QueryResult<T>> {
  if (typeof db.prepare === 'function') {
    const statement = db.prepare(sql);
    const tokens = stripSqlLiteralsAndComments(sql);
    const isReadStatement = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN|VALUES|TABLE|SHOW|DESCRIBE|DESC)\b/i.test(tokens) &&
      !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH)\b/i.test(tokens);
    if (isReadStatement && typeof statement.all === 'function') {
      const rows = statement.all(...params);
      return normalizeQueryResponse<T>(isPromiseLike(rows) ? await rows : rows);
    }
    if (isReadStatement && typeof statement.get === 'function') {
      const row = statement.get(...params);
      const resolved = isPromiseLike(row) ? await row : row;
      return normalizeQueryResponse<T>(resolved === undefined ? [] : [resolved]);
    }
    if (typeof statement.run === 'function') {
      const rawMetadata = statement.run(...params);
      const metadata = isPromiseLike(rawMetadata) ? await rawMetadata : rawMetadata;
      const result = normalizeQueryResponse<T>([]);
      if (metadata && typeof metadata === 'object') {
        result.affectedRows = numberOrUndefined(metadata.changes);
        result.rowCount = result.affectedRows ?? 0;
        result.insertId = scalarId(metadata.lastInsertRowid);
      }
      return result;
    }
  }
  if (typeof db.all === 'function') {
    const rows = db.all(sql, ...params);
    return normalizeQueryResponse<T>(isPromiseLike(rows) ? await rows : rows);
  }
  if (typeof db.exec === 'function') {
    const result = db.exec(sql);
    if (isPromiseLike(result)) await result;
    return { rows: [], rowCount: 0 };
  }
  throw new DatabaseQueryError('SQLite handle does not support prepare/all/run.');
}

async function executeSqlite3<T>(db: AnyRecord, sql: string, params: Primitive[]): Promise<QueryResult<T>> {
  if (/^\s*SELECT\b|^\s*(?:WITH|PRAGMA|EXPLAIN|VALUES|TABLE)\b/i.test(sql)) {
    // sqlite3 accepts a single array/object of bound values before the
    // callback. Keeping params as one argument also works for zero or many
    // values and avoids shifting the callback position.
    const rows = await callNodeStyle<T[]>(db.all.bind(db), [sql, params]);
    return normalizeQueryResponse<T>(rows);
  }
  // sqlite3 exposes `changes` and `lastID` on the Statement object bound as
  // `this` inside the callback, rather than as the callback's second value.
  // Capture that context while still accepting promise-style test doubles
  // (and wrappers that return metadata directly).
  const metadata = await invokeSqlite3Run(db, sql, params);
  const result = normalizeQueryResponse<T>([]);
  if (metadata && typeof metadata === 'object') {
    result.affectedRows = numberOrUndefined(metadata.changes);
    result.rowCount = result.affectedRows ?? 0;
    result.insertId = scalarId(metadata.lastID);
  }
  return result;
}

async function invokeSqlite3Run(db: AnyRecord, sql: string, params: Primitive[]): Promise<AnyRecord | undefined> {
  const run = db.run;
  if (typeof run !== 'function') throw new DatabaseQueryError('SQLite handle does not support run.');
  return await new Promise<AnyRecord | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value && typeof value === 'object' ? value as AnyRecord : undefined);
    };
    function callback(this: AnyRecord, error: unknown, value?: unknown): void {
      // A few wrappers provide metadata as the second callback argument; the
      // native sqlite3 package puts it on `this`, so support both forms.
      finish(error, value && typeof value === 'object' ? value : this);
    }
    try {
      const result = run.call(db, sql, params, callback);
      if (isPromiseLike(result)) {
        result.then((value: unknown) => finish(undefined, value), (error: unknown) => finish(error));
      } else if (result !== undefined && run.length <= 2) {
        // Synchronous fakes may return their metadata and omit callbacks.
        finish(undefined, result);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function scalarId(value: unknown): string | number | bigint | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  // Preserve bigint values exactly; the HTTP layer serializes them as decimal
  // strings, avoiding silent precision loss for large SQLite rowids.
  if (typeof value === 'bigint') return value;
  return undefined;
}
