/** Errors exposed by the database layer.  Messages are intentionally safe to
 * return to an API client and never contain passwords or full connection URLs. */
export class DatabaseAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'DatabaseAdapterError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
  }
}

export class DatabaseConfigError extends DatabaseAdapterError {
  constructor(message: string, cause?: unknown) {
    super('INVALID_CONFIG', message, { cause });
    this.name = 'DatabaseConfigError';
  }
}

export class DatabaseDependencyError extends DatabaseAdapterError {
  readonly dependency: string;

  constructor(dependency: string, cause?: unknown) {
    super(
      'MISSING_DRIVER',
      `Database driver "${dependency}" is not installed. Install it as an optional dependency to enable this adapter.`,
      { cause },
    );
    this.name = 'DatabaseDependencyError';
    this.dependency = dependency;
  }
}

export class DatabaseQueryError extends DatabaseAdapterError {
  readonly sqlState?: string;

  constructor(message: string, options?: { cause?: unknown; sqlState?: string; retryable?: boolean }) {
    super('QUERY_FAILED', message, options);
    this.name = 'DatabaseQueryError';
    this.sqlState = options?.sqlState;
  }
}

export class ReadOnlyQueryError extends DatabaseAdapterError {
  constructor(message = 'Only read-only SQL statements are allowed for this connection.') {
    super('READ_ONLY_VIOLATION', message);
    this.name = 'ReadOnlyQueryError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ('name' in error ? (error as { name?: unknown }).name === 'AbortError' : false)
  );
}

/** Convert an unknown driver error to a stable, non-sensitive public error. */
export function normalizeDriverError(error: unknown, fallback = 'Database operation failed'): DatabaseQueryError {
  if (error instanceof DatabaseAdapterError) return error as DatabaseQueryError;
  const source = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const code = typeof source.code === 'string' ? source.code : undefined;
  const state = typeof source.sqlState === 'string' ? source.sqlState :
    typeof source.sqlstate === 'string' ? source.sqlstate : undefined;
  const message = driverMessage(source.message, fallback);
  const retryable = code != null && /(?:timeout|deadlock|connection|econn|reset|aborted|busy|locked)/i.test(code);
  return new DatabaseQueryError(message, {
    cause: error,
    sqlState: state,
    retryable,
  });
}

function driverMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Driver messages can echo SQL and connection details. Keep only a bounded,
  // sanitized message suitable for logs/API responses.
  const sanitized = value
    .replace(/(?:postgres(?:ql)?|mysql|mariadb):\/\/[^\s"']+/gi, '<connection>')
    .replace(/(password|pwd|passwd)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.slice(0, 500) || fallback;
}
