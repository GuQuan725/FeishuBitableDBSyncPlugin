import { AdapterDependencies, Primitive, QueryField, QueryResult } from './types.js';
import { DatabaseDependencyError, DatabaseQueryError } from './errors.js';
import { createRequire } from 'node:module';

// `createRequire` works in the package's ESM build and can load optional
// CommonJS database drivers without making them compile-time dependencies.
const localRequire = createRequire(import.meta.url);

export function loadOptionalModule(name: string, dependencies: AdapterDependencies): unknown {
  if (dependencies.loadModule) {
    try {
      const loaded = dependencies.loadModule(name);
      if (loaded !== undefined && loaded !== null) return loaded;
    } catch (error) {
      throw new DatabaseDependencyError(name, error);
    }
  }
  try {
    return localRequire(name);
  } catch (error) {
    throw new DatabaseDependencyError(name, error);
  }
  throw new DatabaseDependencyError(name);
}

export function unwrapDefault<T = unknown>(module: unknown): T {
  if (module && typeof module === 'object' && 'default' in (module as Record<string, unknown>)) {
    const value = (module as Record<string, unknown>).default;
    if (value !== undefined) return value as T;
  }
  return module as T;
}

export function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
}

export async function maybeAwait<T>(value: T | PromiseLike<T>): Promise<T> {
  return await value;
}

export function toDriverFields(fields: unknown): QueryField[] | undefined {
  if (!Array.isArray(fields)) return undefined;
  return fields.map((field) => {
    if (typeof field === 'string') return { name: field };
    if (!field || typeof field !== 'object') return { name: String(field) };
    const source = field as Record<string, unknown>;
    return {
      ...source,
      name: String(source.name ?? source.columnName ?? source.COLUMN_NAME ?? ''),
      dataType: source.dataType as string | undefined ?? source.type as string | undefined ?? source.columnType as string | undefined,
    };
  });
}

export function normalizeRows<T = Record<string, unknown>>(rows: unknown, fields?: unknown): QueryResult<T> {
  const list = Array.isArray(rows) ? rows.map((row) => plainRow(row)) as T[] : [];
  return {
    rows: list,
    rowCount: list.length,
    fields: toDriverFields(fields),
  };
}

export function normalizeQueryResponse<T = Record<string, unknown>>(response: unknown): QueryResult<T> {
  if (response && typeof response === 'object') {
    const source = response as Record<string, unknown>;
    if (Array.isArray(source.rows)) {
      const rows = Array.isArray(source.rows) ? source.rows.map((row) => plainRow(row)) as T[] : [];
      return {
        rows,
        rowCount: Number.isFinite(source.rowCount) ? Number(source.rowCount) : rows.length,
        fields: toDriverFields(source.fields),
        affectedRows: numberOrUndefined(source.affectedRows),
        insertId: scalarInsertId(source.insertId),
      };
    }
    // mysql2-style response may be passed through by an injected fake.
    if (Array.isArray(source[0])) {
      return normalizeRows<T>(source[0], source[1]);
    }
  }
  if (Array.isArray(response)) return normalizeRows<T>(response);
  return { rows: [], rowCount: 0 };
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function scalarInsertId(value: unknown): string | number | bigint | undefined {
  return typeof value === 'string' || typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
}

function plainRow<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // Some SQLite drivers return objects with a null prototype. Converting here
  // keeps the adapter contract predictable for JSON serialization and callers
  // using deep equality.
  return { ...(value as Record<string, unknown>) } as T;
}

export function toDriverParams(params: Primitive[]): unknown[] {
  return params.map((value) => value instanceof Date ? value : value);
}

export function callbackError(error: unknown, fallback: string): Error | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error;
  return new DatabaseQueryError(fallback, { cause: error });
}

/** Call a function that may use either promise or node callback style. */
export function callNodeStyle<T>(
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (error: unknown, value: T) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    try {
      const result = fn(...args, done);
      if (isPromiseLike<T>(result)) result.then((value) => done(undefined, value), (error) => done(error, undefined as T));
      // Some lightweight fakes return a value synchronously rather than using a callback.
      else if (result !== undefined && fn.length <= args.length) done(undefined, result as T);
    } catch (error) {
      done(error, undefined as T);
    }
  });
}
