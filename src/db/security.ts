import { DatabaseConfigError, ReadOnlyQueryError } from './errors.js';
import {
  DatabaseConnectionConfig,
  NormalizedDatabaseConfig,
  NormalizedDatabaseType,
  Primitive,
  QueryValue,
  ReadTableOptions,
  normalizeDatabaseType,
} from './types.js';

const MAX_MAX_ROWS = 1_000_000;
const DEFAULT_QUERY_LIMIT = 10_000;

/** Normalize aliases and validate values before a driver is loaded. */
export function normalizeConnectionConfig(input: DatabaseConnectionConfig): NormalizedDatabaseConfig {
  if (!input || typeof input !== 'object') throw new DatabaseConfigError('A database connection configuration is required.');
  if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') {
    throw new DatabaseConfigError('readOnly must be a boolean.');
  }

  let type: NormalizedDatabaseType;
  try {
    type = normalizeDatabaseType(input.type);
  } catch (error) {
    throw new DatabaseConfigError(error instanceof Error ? error.message : 'Unsupported database type.', error);
  }

  const config: NormalizedDatabaseConfig = {
    ...input,
    type,
    user: cleanOptionalString(input.user ?? input.username ?? input.userName, 'user'),
    username: cleanOptionalString(input.username ?? input.user ?? input.userName, 'username'),
    connectionString: cleanOptionalString(input.connectionString ?? input.url ?? input.dsn, 'connectionString'),
    host: cleanOptionalString(input.host, 'host'),
    database: cleanOptionalString(input.database ?? input.dbName, 'database'),
    filename: cleanOptionalString(input.filename ?? input.filePath ?? input.path ?? (type === 'sqlite' ? input.connectionString ?? input.url ?? input.dsn : undefined), 'filename'),
    readOnly: input.readOnly !== false,
    ...(input.maxRows === undefined
      ? {}
      : { maxRows: boundedInteger(input.maxRows, 'maxRows', 1, MAX_MAX_ROWS) }),
  };
  // Keep the normalized object canonical. The aliases are accepted at the
  // boundary, but retaining `dsn`/`url`/`path` alongside an encrypted or
  // normalized connection string can leak credentials through adapter.config.
  // The normalized type intentionally omits these aliases, but they can
  // still be present at runtime because the object starts with `...input`.
  // Cast through `unknown` to make the runtime cleanup explicit without
  // weakening the public NormalizedDatabaseConfig type.
  const aliases = config as unknown as Record<string, unknown>;
  delete aliases.dsn;
  delete aliases.url;
  delete aliases.path;

  if (config.port !== undefined) {
    config.port = boundedInteger(config.port, 'port', 1, 65_535);
  }
  if (config.pool !== undefined) {
    if (typeof config.pool !== 'object' || config.pool === null || Array.isArray(config.pool)) {
      throw new DatabaseConfigError('pool must be an object.');
    }
    config.pool = { ...config.pool };
    if (config.pool.min !== undefined) config.pool.min = boundedInteger(config.pool.min, 'pool.min', 0, 1_000);
    if (config.pool.max !== undefined) config.pool.max = boundedInteger(config.pool.max, 'pool.max', 1, 1_000);
    if (config.pool.min !== undefined && config.pool.max !== undefined && config.pool.min > config.pool.max) {
      throw new DatabaseConfigError('pool.min cannot be greater than pool.max.');
    }
    if (config.pool.idleTimeoutMillis !== undefined) {
      config.pool.idleTimeoutMillis = boundedInteger(config.pool.idleTimeoutMillis, 'pool.idleTimeoutMillis', 0, 86_400_000);
    }
    if (config.pool.connectionTimeoutMillis !== undefined) {
      config.pool.connectionTimeoutMillis = boundedInteger(config.pool.connectionTimeoutMillis, 'pool.connectionTimeoutMillis', 0, 86_400_000);
    }
  }
  if (config.options !== undefined) {
    if (typeof config.options !== 'object' || config.options === null || Array.isArray(config.options)) {
      throw new DatabaseConfigError('options must be an object.');
    }
    config.options = { ...config.options };
  }

  if (config.ssl !== undefined && typeof config.ssl !== 'boolean' &&
      (typeof config.ssl !== 'object' || config.ssl === null || Array.isArray(config.ssl))) {
    throw new DatabaseConfigError('ssl must be a boolean or object.');
  }
  if (config.ssl && typeof config.ssl === 'object') {
    config.ssl = { ...config.ssl };
    const sslRecord = config.ssl as Record<string, unknown>;
    if (sslRecord.enabled !== undefined && typeof sslRecord.enabled !== 'boolean') {
      throw new DatabaseConfigError('ssl.enabled must be a boolean.');
    }
    if (sslRecord.rejectUnauthorized !== undefined && typeof sslRecord.rejectUnauthorized !== 'boolean') {
      throw new DatabaseConfigError('ssl.rejectUnauthorized must be a boolean.');
    }
    for (const key of ['ca', 'cert', 'key']) {
      const value = sslRecord[key];
      if (value !== undefined && typeof value !== 'string') {
        throw new DatabaseConfigError(`ssl.${key} must be a string.`);
      }
      if (typeof value === 'string' && /[\u0000\r\n]/.test(value)) {
        throw new DatabaseConfigError(`ssl.${key} contains an invalid control character.`);
      }
    }
  }

  if (type === 'sqlite') {
    if (!config.filename) throw new DatabaseConfigError('SQLite requires filename (or path).');
    if (/[\u0000]/.test(config.filename)) throw new DatabaseConfigError('SQLite filename contains an invalid NUL character.');
  } else if (!config.connectionString && !config.host) {
    throw new DatabaseConfigError(`${type} requires host or connectionString.`);
  }

  if (config.connectionString) validateConnectionString(config.connectionString, type);
  if (config.host) validateHost(config.host);
  if (config.database && /[\u0000\r\n]/.test(config.database)) {
    throw new DatabaseConfigError('database contains an invalid control character.');
  }
  if (config.password !== undefined && typeof config.password !== 'string') {
    throw new DatabaseConfigError('password must be a string.');
  }
  return config;
}

function cleanOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new DatabaseConfigError(`${field} must be a string.`);
  if (/[\u0000\r\n]/.test(value)) throw new DatabaseConfigError(`${field} contains an invalid control character.`);
  return value.trim();
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    throw new DatabaseConfigError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return numeric;
}

function validateHost(host: string): void {
  if (host.length > 255 || /[\u0000\r\n\s/\\]/.test(host)) {
    throw new DatabaseConfigError('host contains invalid characters.');
  }
}

function validateConnectionString(value: string, type: NormalizedDatabaseType): void {
  if (value.length > 8_192 || /[\u0000\r\n]/.test(value)) {
    throw new DatabaseConfigError('connectionString contains an invalid value.');
  }
  // DSNs are allowed to be driver-specific, but an obvious cross-driver URL
  // usually indicates a configuration mistake. SQLite accepts plain paths.
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (!match) return;
  const scheme = match[1].toLowerCase();
  if (type === 'postgres' && !['postgres', 'postgresql'].includes(scheme)) {
    throw new DatabaseConfigError('PostgreSQL connectionString must use postgres:// or postgresql://.');
  }
  if (type === 'mysql' && !['mysql', 'mariadb'].includes(scheme)) {
    throw new DatabaseConfigError('MySQL/MariaDB connectionString must use mysql:// or mariadb://.');
  }
}

/**
 * Assert a SQL statement is a single statement and, when requested, read-only.
 * This is a defense-in-depth check; values must still be passed as parameters.
 */
export function assertSafeSql(sql: string, readOnly = true): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new ReadOnlyQueryError('SQL must be a non-empty string.');
  }
  if (sql.length > 1_000_000 || /[\u0000]/.test(sql)) {
    throw new ReadOnlyQueryError('SQL is too large or contains an invalid NUL character.');
  }
  // MySQL versioned comments (`/*!...*/`) are executable SQL, not inert
  // comments. Reject them rather than accidentally allowing a write hidden in
  // a comment while sanitising the token stream below.
  if (/\/\*![\s\S]*?\*\//.test(sql)) {
    throw new ReadOnlyQueryError('Executable SQL comments are not allowed.');
  }

  const clean = stripSqlLiteralsAndComments(sql).trim();
  if (!clean) throw new ReadOnlyQueryError('SQL must contain a statement.');
  // Permit one trailing semicolon, but never a second statement. A semicolon
  // inside a quoted string/comment was removed above.
  const withoutTrailing = clean.replace(/;\s*$/, '').trim();
  if (withoutTrailing.includes(';')) {
    throw new ReadOnlyQueryError('Multiple SQL statements are not allowed.');
  }
  if (!readOnly) return;

  const first = /^([a-z]+)/i.exec(withoutTrailing)?.[1]?.toUpperCase();
  const allowed = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'PRAGMA']);
  if (!first || !allowed.has(first)) {
    throw new ReadOnlyQueryError();
  }
  // WITH can prefix a mutating CTE. Reject mutation keywords anywhere in its
  // token stream. PRAGMA assignments likewise mutate SQLite state.
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|ANALYZE|REINDEX|CLUSTER|REFRESH|VACUUM|ATTACH|DETACH|COMMENT|LISTEN|NOTIFY|DISCARD)\b/i.test(withoutTrailing)) {
    throw new ReadOnlyQueryError();
  }
  if (/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|INTO\b|LOAD_FILE|LOAD_EXTENSION|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|LO_IMPORT|DBLINK_CONNECT|DBLINK_EXECUTE)\b/i.test(withoutTrailing)) {
    throw new ReadOnlyQueryError('Potentially unsafe SQL operation is not allowed.');
  }
  if (/\b(?:FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+SHARE|LOCK\s+IN\s+SHARE\s+MODE|SET_CONFIG|PG_SLEEP|PG_ADVISORY_LOCK|PG_TRY_ADVISORY_LOCK|NEXTVAL|SETVAL|SLEEP|BENCHMARK)\s*\(?/i.test(withoutTrailing)) {
    throw new ReadOnlyQueryError('Potentially stateful SQL operation is not allowed.');
  }
  if (first === 'PRAGMA') {
    // SQLite accepts both assignment and function-like forms for pragmas.
    // The latter is easy to miss (`PRAGMA journal_mode(WAL)`) but still
    // changes connection/database state.  Permit function syntax only for
    // documented introspection pragmas used by the adapter.
    if (/\bPRAGMA\s+(?:(?:[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*\s*=\s*/i.test(withoutTrailing)) {
      throw new ReadOnlyQueryError('Mutating PRAGMA statements are not allowed.');
    }
    const pragmaBody = withoutTrailing.replace(/^PRAGMA\s+/i, '').trim();
    const pragmaMatch = /^(?:(?:[a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)(.*)$/i.exec(pragmaBody);
    const pragmaName = pragmaMatch?.[1]?.toLowerCase();
    const pragmaRemainder = pragmaMatch?.[2] || '';
    const readOnlyFunctionPragmas = new Set([
      'table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list',
      'foreign_key_list', 'database_list', 'collation_list', 'compile_options',
      'function_list', 'module_list', 'pragma_list', 'integrity_check',
      'quick_check',
    ]);
    if (pragmaRemainder.trimStart().startsWith('(') && !readOnlyFunctionPragmas.has(pragmaName || '')) {
      throw new ReadOnlyQueryError('Mutating PRAGMA statements are not allowed.');
    }
  }
}

/** Strip SQL quoted values/comments while retaining enough token structure. */
export function stripSqlLiteralsAndComments(sql: string): string {
  let output = '';
  let i = 0;
  let mode: 'single' | 'double' | 'backtick' | 'dollar' | 'lineComment' | 'blockComment' | null = null;
  let dollarDelimiter = '';
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (mode === 'lineComment') {
      if (c === '\n' || c === '\r') mode = null;
      output += ' ';
      i += 1;
      continue;
    }
    if (mode === 'blockComment') {
      if (c === '*' && n === '/') {
        mode = null;
        output += '  ';
        i += 2;
      } else {
        output += ' ';
        i += 1;
      }
      continue;
    }
    if (mode === 'dollar') {
      const end = sql.indexOf(dollarDelimiter, i);
      if (end < 0) {
        // An unterminated dollar quote is treated as a literal through EOF;
        // assertSafeSql will still inspect the statement prefix safely.
        output += ' '.repeat(sql.length - i);
        break;
      }
      output += ' '.repeat(end - i + dollarDelimiter.length);
      i = end + dollarDelimiter.length;
      mode = null;
      dollarDelimiter = '';
      continue;
    }
    if (mode) {
      const close = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === close) {
        if (sql[i + 1] === close) {
          output += '  ';
          i += 2;
        } else {
          mode = null;
          output += ' ';
          i += 1;
        }
      } else if (mode === 'single' && c === '\\') {
        output += '  ';
        i += Math.min(2, sql.length - i);
      } else {
        output += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '-' && n === '-') {
      mode = 'lineComment';
      output += '  ';
      i += 2;
    } else if (c === '#' && (i === 0 || /\s/.test(sql[i - 1]))) {
      // MySQL's hash-style single-line comment.
      mode = 'lineComment';
      output += ' ';
      i += 1;
    } else if (c === '/' && n === '*') {
      mode = 'blockComment';
      output += '  ';
      i += 2;
    } else if (c === "'") {
      mode = 'single';
      output += ' ';
      i += 1;
    } else if (c === '"') {
      mode = 'double';
      output += ' ';
      i += 1;
    } else if (c === '`') {
      mode = 'backtick';
      output += ' ';
      i += 1;
    } else if (c === '$') {
      // PostgreSQL dollar-quoted strings: $$...$$ and $tag$...$tag$.
      // Ignore parameter placeholders such as $1 (they do not match).
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        mode = 'dollar';
        dollarDelimiter = match[0];
        output += ' '.repeat(dollarDelimiter.length);
        i += dollarDelimiter.length;
      } else {
        output += c;
        i += 1;
      }
    } else {
      output += c;
      i += 1;
    }
  }
  return output;
}

// SQL identifiers are quoted before interpolation, so spaces, hyphens, and
// non-ASCII names are valid. Delimiters that could turn one identifier into a
// statement/path are rejected explicitly. This supports legacy schemas whose
// column names are not conventional [A-Za-z_][A-Za-z0-9_]* names.
const IDENTIFIER_RE = /^[^\u0000\r\n;.[\]"'`]+$/u;

/** Validate and quote one SQL identifier. Never interpolate raw user input. */
export function quoteIdentifier(identifier: string, dialect: NormalizedDatabaseType): string {
  if (
    typeof identifier !== 'string' ||
    identifier.length === 0 ||
    identifier.length > 256 ||
    identifier.trim() !== identifier ||
    !IDENTIFIER_RE.test(identifier)
  ) {
    throw new DatabaseConfigError(`Invalid SQL identifier: ${String(identifier)}`);
  }
  if (dialect === 'mysql') return `\`${identifier}\``;
  return `"${identifier}"`;
}

export function quoteIdentifierPath(identifier: string, dialect: NormalizedDatabaseType): string {
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new DatabaseConfigError('A table identifier is required.');
  }
  const parts = identifier.split('.');
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER_RE.test(part))) {
    throw new DatabaseConfigError(`Invalid SQL table identifier: ${identifier}`);
  }
  return parts.map((part) => quoteIdentifier(part, dialect)).join('.');
}

export function normalizeReadLimit(value: number | undefined, fallback = DEFAULT_QUERY_LIMIT): number {
  if (value === undefined) return fallback;
  return boundedInteger(value, 'limit', 1, MAX_MAX_ROWS);
}

export function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  return boundedInteger(value, 'offset', 0, Number.MAX_SAFE_INTEGER);
}

export function redactConnectionConfig(config: DatabaseConnectionConfig): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...config };
  for (const key of ['password', 'connectionString', 'dsn', 'url']) {
    if (key in clone && clone[key] !== undefined) clone[key] = '<redacted>';
  }
  if (clone.ssl && typeof clone.ssl === 'object') {
    clone.ssl = redactNestedSecrets(clone.ssl, new Set(['key', 'cert', 'ca']));
  }
  if (clone.options && typeof clone.options === 'object') {
    // Keep this list in sync with the server-side credential protection for
    // driver options. Adapter-specific options are intentionally extensible,
    // so known credential-shaped keys must be redacted at every depth.
    clone.options = redactNestedSecrets(clone.options, new Set([
      'password', 'pass', 'pwd', 'token', 'accessToken', 'secret',
      'clientSecret', 'privateKey', 'connectionString', 'dsn', 'url',
    ]));
  }
  return clone;
}

/** Recursively redact known secret keys while handling arrays and cycles. */
function redactNestedSecrets(
  value: unknown,
  secretKeys: ReadonlySet<string>,
  seen = new WeakMap<object, unknown>(),
  ancestors = new WeakSet<object>(),
  parentField?: string,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (ancestors.has(value)) return undefined;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    ancestors.add(value);
    for (const item of value) output.push(redactNestedSecrets(item, secretKeys, seen, ancestors));
    ancestors.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // TLS material is only secret when it lives under an ssl/tls container;
    // a generic option named `key` may be an ordinary driver setting.
    const tlsSecret = (parentField === 'ssl' || parentField === 'tls') &&
      (key === 'ca' || key === 'cert' || key === 'key');
    const redacted = (secretKeys.has(key) || tlsSecret) && typeof entry === 'string'
      ? '<redacted>'
      : redactNestedSecrets(entry, secretKeys, seen, ancestors, key);
    Object.defineProperty(output, key, {
      value: redacted,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return output;
}

/** Build a parameterized WHERE clause from the constrained filter format. */
export function buildWhereClause(
  where: ReadTableOptions['where'],
  dialect: NormalizedDatabaseType,
  startIndex = 1,
): { sql: string; params: Primitive[] } {
  if (!where) return { sql: '', params: [] };
  const filters = Array.isArray(where)
    ? where
    : Object.entries(where).map(([column, value]) => ({
      column,
      operator: Array.isArray(value) ? 'IN' as const : '=' as const,
      value,
    }));
  const clauses: string[] = [];
  const params: Primitive[] = [];
  let index = startIndex;
  for (const filter of filters) {
    if (!filter || typeof filter.column !== 'string') throw new DatabaseConfigError('Filter column is required.');
    const column = quoteIdentifier(filter.column, dialect);
    const requestedOperator = filter.operator;
    const op = String(requestedOperator ?? '=').toUpperCase() as string;
    // Object-style filters such as `{ deletedAt: null }` are more naturally
    // represented as IS NULL (SQL's `= NULL` never matches).
    if ((!requestedOperator || requestedOperator === '=') && (filter.value === null || filter.value === undefined)) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      clauses.push(`${column} ${op}`);
    } else if (op === 'IN' || op === 'NOT IN') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new DatabaseConfigError(`${op} requires a non-empty array.`);
      const marks = filter.value.map(() => placeholder(dialect, index++));
      clauses.push(`${column} ${op} (${marks.join(', ')})`);
      params.push(...(filter.value as Primitive[]));
    } else if (op === 'BETWEEN') {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new DatabaseConfigError('BETWEEN requires two values.');
      clauses.push(`${column} BETWEEN ${placeholder(dialect, index++)} AND ${placeholder(dialect, index++)}`);
      params.push(filter.value[0] as Primitive, filter.value[1] as Primitive);
    } else if (['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'ILIKE'].includes(op)) {
      if (Array.isArray(filter.value)) throw new DatabaseConfigError(`${op} accepts one value.`);
      const mark = placeholder(dialect, index++);
      if (op === 'ILIKE' && dialect !== 'postgres') {
        clauses.push(`LOWER(${column}) LIKE LOWER(${mark})`);
      } else {
        clauses.push(`${column} ${op} ${mark}`);
      }
      params.push(filter.value as Primitive);
    } else {
      throw new DatabaseConfigError(`Unsupported filter operator: ${op}`);
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export function placeholder(dialect: NormalizedDatabaseType, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?';
}
