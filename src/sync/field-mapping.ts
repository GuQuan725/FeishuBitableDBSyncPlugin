import {
  DatabaseRow,
  DatabaseRowsInput,
  FieldMapping,
  FieldMappingInput,
  MappingTransform,
  MappingError,
  BitableFieldValue,
} from './types.js';

/** A mapped row plus its source row, useful when deriving an upsert key. */
export interface MappedRow {
  fields: Record<string, BitableFieldValue>;
  source: DatabaseRow;
}

/**
 * Resolve a value from a row. Dot notation and simple bracket notation are
 * supported (`customer.id`, `items[0].sku`). A literal key is preferred when
 * it exists, so columns containing dots remain usable.
 */
export function getPathValue(row: unknown, path: string): unknown {
  if (row === null || row === undefined) return undefined;
  if (!path) return row;

  if (typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, path)) {
    return (row as Record<string, unknown>)[path];
  }

  const tokens = tokenizePath(path);
  let current: unknown = row;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object' && typeof current !== 'function') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function tokenizePath(path: string): string[] {
  // Handles foo.bar, foo[0], foo['bar'] and foo["bar"].
  const tokens: string[] = [];
  path.replace(/([^.[\]]+)|\[(?:"([^"]*)"|'([^']*)'|([^\]]+))\]/g, (_m, dot, quotedDouble, quotedSingle, bracket) => {
    const value = dot ?? quotedDouble ?? quotedSingle ?? bracket;
    if (value !== undefined) tokens.push(String(value).trim());
    return '';
  });
  return tokens;
}

export function normalizeMapping(input: FieldMappingInput, index = 0): FieldMapping {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MappingError(`Mapping at index ${index} must be an object`);
  }
  const candidate = input as FieldMappingInput & {
    sourceField?: string;
    targetField?: string;
  };
  const source = firstNonBlank(candidate.source, candidate.sourceField);
  const target = firstNonBlank(candidate.target, candidate.targetField);
  if (!source || !target) {
    throw new MappingError(
      `Mapping at index ${index} must define both source and target fields`,
    );
  }
  return {
    source,
    target,
    transform: resolveTransformer(candidate.transform ?? candidate.formatter),
    defaultValue: candidate.defaultValue,
    omitIfEmpty: candidate.omitIfEmpty,
    required: candidate.required,
  };
}

/**
 * Resolve a transform from a JSON-safe name or return a custom function as-is.
 * Keeping this helper public lets API layers validate mapping configuration
 * before starting a potentially long-running sync.
 */
export function resolveTransformer(transform?: MappingTransform): ((value: unknown, row: DatabaseRow) => BitableFieldValue | Promise<BitableFieldValue>) | undefined {
  if (!transform) return undefined;
  if (typeof transform === 'function') return transform;
  switch (transform) {
    case 'text':
      return (value) => value === null || value === undefined ? '' : String(value);
    case 'number':
      return (value) => {
        if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
        const number = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(number)) throw new Error(`Cannot convert value to number: ${String(value)}`);
        return number;
      };
    case 'date':
      return (value) => {
        if (value === null || value === undefined || value === '') return null;
        const date = value instanceof Date ? value : new Date(value as string | number);
        const timestamp = date.getTime();
        if (!Number.isFinite(timestamp)) throw new Error(`Cannot convert value to date: ${String(value)}`);
        // Feishu date fields accept Unix timestamps in milliseconds.
        return timestamp;
      };
    case 'boolean':
      return (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (value === null || value === undefined || value === '') return false;
        const normalized = String(value).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', '是', '有'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off', '否', '无'].includes(normalized)) return false;
        throw new Error(`Cannot convert value to boolean: ${String(value)}`);
      };
    case 'json':
      return (value) => {
        if (value === null || value === undefined || typeof value !== 'string') return value as BitableFieldValue;
        try {
          return JSON.parse(value) as BitableFieldValue;
        } catch {
          throw new Error(`Cannot parse JSON value: ${value}`);
        }
      };
    case 'auto':
      return (value) => {
        if (value instanceof Date) return value.getTime();
        if (value === undefined || value === null) return value as BitableFieldValue;
        if (typeof value === 'bigint') return String(value);
        if (typeof value === 'object') {
          // JSON-compatible objects can be sent directly to Bitable. For
          // exotic values fall back to a readable string instead of failing
          // JSON.stringify deep in the HTTP client.
          try {
            JSON.stringify(value);
            return value as BitableFieldValue;
          } catch {
            return String(value);
          }
        }
        return value as BitableFieldValue;
      };
    default:
      throw new MappingError(`Unsupported mapping transform: ${String(transform)}`);
  }
}

export function normalizeMappings(inputs: FieldMappingInput[]): FieldMapping[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new MappingError('At least one field mapping is required');
  }
  const result = inputs.map((input, index) => normalizeMapping(input, index));
  const targets = new Set<string>();
  for (const mapping of result) {
    if (targets.has(mapping.target)) {
      throw new MappingError(`Duplicate target field in mappings: ${mapping.target}`);
    }
    targets.add(mapping.target);
  }
  return result;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Map one database row to Feishu's `{ fields: ... }` shape. */
export async function mapRow(
  row: DatabaseRow,
  mappings: FieldMappingInput[],
  rowIndex?: number,
): Promise<MappedRow> {
  const normalized = normalizeMappings(mappings);
  const fields: Record<string, BitableFieldValue> = {};

  for (const mapping of normalized) {
    let value = getPathValue(row, mapping.source);
    // Check property presence so an explicit `null` (or `undefined`) can be
    // used intentionally as a default value in a programmatic configuration.
    if (isEmpty(value) && Object.prototype.hasOwnProperty.call(mapping, 'defaultValue')) {
      value = mapping.defaultValue;
    }

    if (isEmpty(value)) {
      if (mapping.required) {
        throw new MappingError(
          `Required source field "${mapping.source}" is empty`,
          { rowIndex, source: mapping.source },
        );
      }
      if (mapping.omitIfEmpty) continue;
    }

    const transform = resolveTransformer(mapping.transform);
    if (transform && (!isEmpty(value) || !mapping.omitIfEmpty)) {
      try {
        value = await transform(value, row);
      } catch (cause) {
        throw new MappingError(
          `Failed to transform source field "${mapping.source}"`,
          { rowIndex, source: mapping.source, cause },
        );
      }
    }
    // Define special names as own data properties instead of invoking the
    // legacy `__proto__` setter on Object.prototype.
    Object.defineProperty(fields, mapping.target, {
      value: value as BitableFieldValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return { fields, source: row };
}

/** Map a collection while preserving the row index in mapping errors. */
export async function mapRows(
  rows: DatabaseRowsInput,
  mappings: FieldMappingInput[],
  options: { skipInvalidRows?: boolean } = {},
): Promise<{ rows: MappedRow[]; errors: MappingError[]; skipped: number }> {
  // Validate once rather than for every row and fail early for bad config.
  const normalized = normalizeMappings(mappings);
  const mapped: MappedRow[] = [];
  const errors: MappingError[] = [];
  let index = 0;
  for await (const value of rows) {
    const rowValues = Array.isArray(value) ? value : [value];
    for (const row of rowValues) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        // Keep indexes aligned with the source stream and report malformed
        // values instead of silently losing them. This makes skipped counts
        // and subsequent MappingError rowIndex values actionable.
        const mappingError = new MappingError('Source row must be a non-null object', { rowIndex: index });
        errors.push(mappingError);
        index += 1;
        if (!options.skipInvalidRows) throw mappingError;
        continue;
      }
    try {
      mapped.push(await mapRow(row, normalized, index));
    } catch (error) {
      const mappingError = error instanceof MappingError
        ? error
        : new MappingError(String(error), { rowIndex: index });
      errors.push(mappingError);
      if (!options.skipInvalidRows) throw mappingError;
    }
    index += 1;
    }
  }
  return { rows: mapped, errors, skipped: errors.length };
}

/** Find the target field corresponding to a source unique-key column. */
export function targetForSource(
  mappings: FieldMappingInput[],
  source: string,
  explicitTarget?: string,
): string | undefined {
  if (explicitTarget) return explicitTarget;
  const mapping = normalizeMappings(mappings).find((entry) => entry.source === source);
  return mapping?.target;
}

/** Stable key representation for values returned by database/API clients. */
export function serializeKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Descriptive aliases retained for callers that prefer an explicit "fields"
// suffix in their integration code.
export const mapRowToFields = mapRow;
export const mapRowsToFields = mapRows;
