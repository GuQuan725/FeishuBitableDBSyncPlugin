import {
  DatabaseRow,
  DatabaseRowsInput,
  FeishuBatchResult,
  FeishuClientLike,
  FeishuRecord,
  FieldMappingInput,
  MappingError,
  SyncConfig,
  SyncError,
  SyncKey,
  SyncProgress,
  SyncResult,
} from './types.js';
import {
  getPathValue,
  mapRow,
  normalizeMappings,
  serializeKey,
  MappedRow,
} from './field-mapping.js';

const MAX_BATCH_SIZE = 500;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

interface PendingCreate {
  fields: Record<string, any>;
  rowIndex: number;
  key?: string;
}

interface PendingUpdate {
  record_id: string;
  fields: Record<string, any>;
  rowIndex: number;
  key?: string;
}

export interface SyncServiceOptions {
  /** Optional logger; no logging is performed by default. */
  logger?: Pick<Console, 'debug' | 'warn' | 'error'>;
}

/** Minimal database adapter shape needed by `syncDatabaseTable`. */
export interface DatabaseTableSource {
  iterateRows<T extends DatabaseRow = DatabaseRow>(
    table: string,
    // Intentionally permissive: concrete adapters expose their own typed
    // read options, while this bridge only forwards them.
    options?: any,
  ): AsyncIterable<T[]>;
}

/**
 * Synchronises database rows into a Feishu Bitable table.
 *
 * The service is intentionally independent of a concrete database adapter and
 * receives a `FeishuClientLike`; a fake implementation can therefore be used
 * in unit tests without HTTP or Feishu credentials.
 */
export class BitableSyncService {
  private readonly client: FeishuClientLike;
  private readonly logger?: SyncServiceOptions['logger'];

  constructor(client: FeishuClientLike, options: SyncServiceOptions = {}) {
    this.client = client;
    this.logger = options.logger;
  }

  async sync(
    rows: DatabaseRowsInput,
    config: SyncConfig,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    throwIfAborted(signal);
    const mode = config.mode || 'upsert';
    if (mode !== 'upsert' && mode !== 'append') {
      throw new Error(`Unsupported sync mode: ${String(config.mode)}`);
    }
    if (!config.appToken?.trim() || !config.tableId?.trim()) {
      throw new Error('appToken and tableId are required');
    }
    const mappings = normalizeMappings(config.mappings);
    // Validate the upsert key before consuming the source stream. This keeps
    // an invalid configuration from appearing successful when the source
    // happens to be empty.
    const keyDefinition = mode === 'upsert'
      ? resolveKey(config.uniqueKey ?? config.key, mappings)
      : undefined;
    if (mode === 'upsert' && !keyDefinition) {
      throw new Error('upsert mode requires uniqueKey (or key) matching a mapped source field');
    }
    const batchSize = clampBatchSize(config.batchSize);
    const pageSize = clampPageSize(config.pageSize);
    const result: SyncResult = {
      mode,
      totalRows: 0,
      mappedRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    const mapped: Array<{ mapped: MappedRow; rowIndex: number }> = [];
    // Map as pages arrive instead of first copying the entire source table to
    // a second in-memory array.  We retain mapped rows for duplicate-key
    // classification, but database pages themselves can be released as soon
    // as they have been processed.
    let rowIndex = 0;
    for await (const sourceRow of flattenRowPages(rows)) {
      throwIfAborted(signal);
      result.totalRows += 1;
      try {
        const mappedRow = await mapRow(sourceRow, mappings, rowIndex);
        throwIfAborted(signal);
        mapped.push({ mapped: mappedRow, rowIndex });
        result.mappedRows += 1;
      } catch (cause) {
        // An abort is control flow, not a bad source row.  Never convert it
        // into a skipped mapping error when skipInvalidRows is enabled.
        if (isAbortError(cause) || signal?.aborted) throw cause;
        const error = asSyncError('map', cause, rowIndex);
        result.errors.push(error);
        result.skipped += 1;
        if (!config.skipInvalidRows) throw cause;
      }
      rowIndex += 1;
    }

    throwIfAborted(signal);
    if (mapped.length === 0) return result;

    let existing: FeishuRecord[] = [];
    // A unique key only influences upsert classification. In append mode a
    // caller may leave a stale key setting in a shared config; it must not
    // cause rows with empty keys to be dropped.
    if (mode === 'upsert' && keyDefinition) {
      throwIfAborted(signal);
      existing = await listAllRecordsCompat(this.client, config.appToken, config.tableId, {
        pageSize,
        fieldNames: [keyDefinition.target],
        signal,
      });
      throwIfAborted(signal);
    }

    const existingByKey = new Map<string, FeishuRecord>();
    if (keyDefinition) {
      for (const record of existing) {
        const key = serializeKey(record.fields?.[keyDefinition.target]);
        if (key && !existingByKey.has(key)) existingByKey.set(key, record);
      }
    }

    const creates: PendingCreate[] = [];
    const updates: PendingUpdate[] = [];
    // Track keys planned in this run. This prevents duplicate creates for a
    // repeated key and makes an incoming duplicate update the first payload.
    const planned = new Map<string, PendingCreate | PendingUpdate>();

    for (const entry of mapped) {
      throwIfAborted(signal);
      const key = keyDefinition
        ? serializeKey(
          Object.prototype.hasOwnProperty.call(entry.mapped.fields, keyDefinition.target)
            ? entry.mapped.fields[keyDefinition.target]
            : getPathValue(entry.mapped.source, keyDefinition.source),
        )
        : '';
      if (keyDefinition && !key) {
        const error = asSyncError(
          'map',
          new MappingError(`Unique key "${keyDefinition.source}" is empty`, {
            rowIndex: entry.rowIndex,
            source: keyDefinition.source,
          }),
          entry.rowIndex,
        );
        result.errors.push(error);
        result.skipped += 1;
        if (!config.skipInvalidRows) throw new MappingError(error.message, { rowIndex: entry.rowIndex });
        continue;
      }

      if (mode === 'append') {
        creates.push({ fields: entry.mapped.fields, rowIndex: entry.rowIndex });
        continue;
      }

      const existingRecord = keyDefinition ? existingByKey.get(key) : undefined;
      if (existingRecord?.record_id || existingRecord?.recordId) {
        const update: PendingUpdate = {
          record_id: String(existingRecord.record_id || existingRecord.recordId),
          fields: entry.mapped.fields,
          rowIndex: entry.rowIndex,
          key,
        };
        const prior = key ? planned.get(key) : undefined;
        if (prior && 'record_id' in prior) {
          // Last row wins for duplicate keys when updating an existing record.
          (prior as PendingUpdate).fields = update.fields;
          (prior as PendingUpdate).rowIndex = update.rowIndex;
        } else {
          updates.push(update);
          if (key) planned.set(key, update);
        }
      } else {
        const create: PendingCreate = { fields: entry.mapped.fields, rowIndex: entry.rowIndex, key };
        const prior = key ? planned.get(key) : undefined;
        if (prior && !('record_id' in prior)) {
          // Last row wins and remains a single create.
          (prior as PendingCreate).fields = create.fields;
          (prior as PendingCreate).rowIndex = create.rowIndex;
        } else {
          creates.push(create);
          if (key) planned.set(key, create);
        }
      }
    }

    if (config.dryRun) {
      // Dry runs still classify rows, making the result useful for previews,
      // but deliberately avoid all mutating API calls.
      result.created += creates.length;
      result.updated += updates.length;
      return result;
    }

    throwIfAborted(signal);
    await this.flushCreates(creates, config, batchSize, result, signal);
    throwIfAborted(signal);
    await this.flushUpdates(updates, config, batchSize, result, signal);
    throwIfAborted(signal);
    return result;
  }

  private async flushCreates(
    records: PendingCreate[],
    config: SyncConfig,
    batchSize: number,
    result: SyncResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (records.length === 0) return;
    const batchCount = Math.ceil(records.length / batchSize);
    for (let offset = 0, batchIndex = 0; offset < records.length; offset += batchSize, batchIndex += 1) {
      throwIfAborted(signal);
      const chunk = records.slice(offset, offset + batchSize);
      try {
        const responses = await this.client.batchCreateRecords(
          config.appToken,
          config.tableId,
          chunk.map(({ fields }) => ({ fields })),
          { batchSize, signal },
        );
        throwIfAborted(signal);
        const count = countResponseRecords(responses, chunk.length);
        result.created += count;
        await reportProgress(config, {
          operation: 'create',
          batchIndex: batchIndex + 1,
          batchCount,
          records: count,
        });
      } catch (cause) {
        if (isAbortError(cause) || signal?.aborted) throw cause;
        this.logger?.error?.('Feishu batch create failed', cause);
        result.errors.push(asSyncError('create', cause, chunk[0]?.rowIndex));
        if (!config.continueOnError) throw cause;
      }
    }
  }

  private async flushUpdates(
    records: PendingUpdate[],
    config: SyncConfig,
    batchSize: number,
    result: SyncResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (records.length === 0) return;
    const batchCount = Math.ceil(records.length / batchSize);
    for (let offset = 0, batchIndex = 0; offset < records.length; offset += batchSize, batchIndex += 1) {
      throwIfAborted(signal);
      const chunk = records.slice(offset, offset + batchSize);
      try {
        const responses = await this.client.batchUpdateRecords(
          config.appToken,
          config.tableId,
          chunk.map(({ record_id, fields }) => ({ record_id, fields })),
          { batchSize, signal },
        );
        throwIfAborted(signal);
        const count = countResponseRecords(responses, chunk.length);
        result.updated += count;
        await reportProgress(config, {
          operation: 'update',
          batchIndex: batchIndex + 1,
          batchCount,
          records: count,
        });
      } catch (cause) {
        if (isAbortError(cause) || signal?.aborted) throw cause;
        this.logger?.error?.('Feishu batch update failed', cause);
        result.errors.push(asSyncError('update', cause, chunk[0]?.rowIndex));
        if (!config.continueOnError) throw cause;
      }
    }
  }
}

/** Convenience function for callers that do not need to retain a service. */
export async function syncToBitable(
  client: FeishuClientLike,
  rows: DatabaseRowsInput,
  config: SyncConfig,
  signal?: AbortSignal,
): Promise<SyncResult> {
  return new BitableSyncService(client).sync(rows, config, signal);
}

/**
 * Read a selected database table page-by-page and synchronise it. The source
 * adapter is intentionally structural, so the existing postgres/mysql/sqlite
 * adapters can be passed without importing them into this package.
 */
export async function syncDatabaseTable(
  source: DatabaseTableSource,
  client: FeishuClientLike,
  table: string,
  config: SyncConfig & {
    sourceOptions?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<SyncResult> {
  const options = { ...(config.sourceOptions || {}), signal };
  const rows = flattenRowPages(source.iterateRows<DatabaseRow>(table, options));
  return syncToBitable(client, rows, config, signal);
}

/** Flatten either a row stream or a stream of pages into individual rows. */
export async function* flattenRowPages(
  input: DatabaseRowsInput | AsyncIterable<DatabaseRow[]>,
): AsyncGenerator<DatabaseRow, void, unknown> {
  for await (const value of input) {
    if (Array.isArray(value)) {
      // A database adapter emits pages (`DatabaseRow[]`), while callers may
      // also provide an ordinary iterable of rows.  Validate each item rather
      // than using only the first item: one malformed row at the start of a
      // page must not make all following valid rows disappear.
      for (const row of value) if (isDatabaseRow(row)) yield row;
    } else if (isDatabaseRow(value)) {
      yield value;
    }
  }
}

interface ResolvedKey {
  source: string;
  target: string;
}

function resolveKey(key: SyncKey | undefined, mappings: FieldMappingInput[]): ResolvedKey | undefined {
  if (!key) return undefined;
  if (typeof key === 'string') {
    const normalizedKey = key.trim();
    if (!normalizedKey) return undefined;
    const normalized = normalizeMappings(mappings);
    const sourceMapping = normalized.find((entry) => entry.source === normalizedKey);
    if (sourceMapping) return { source: sourceMapping.source, target: sourceMapping.target };
    // Also accept a target field name, which is convenient when the UI stores
    // the Bitable field identifier rather than the source column name.
    const targetMapping = normalized.find((entry) => entry.target === normalizedKey);
    if (targetMapping) return { source: targetMapping.source, target: targetMapping.target };
    return undefined;
  }
  const source = key.source || key.sourceField;
  const explicitTarget = key.target || key.targetField;
  const normalizedSource = typeof source === 'string' ? source.trim() : '';
  const normalizedTarget = typeof explicitTarget === 'string' ? explicitTarget.trim() : '';
  if (!normalizedSource) return undefined;
  const normalized = normalizeMappings(mappings);
  const sourceMapping = normalized.find((entry) => entry.source === normalizedSource);
  if (!sourceMapping) return undefined;
  if (normalizedTarget && normalizedTarget !== sourceMapping.target) return undefined;
  return {
    source: normalizedSource,
    target: normalizedTarget || sourceMapping.target,
  };
}

function countResponseRecords(responses: FeishuBatchResult[], fallback: number): number {
  const count = responses.reduce((sum, response) => sum + response.records.length, 0);
  // Some fake clients (and a few proxies) do not return records in the body;
  // successful API calls still represent all requested records.
  return count || fallback;
}

function clampBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(value as number)));
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(value as number)));
}

function asSyncError(operation: SyncError['operation'], cause: unknown, rowIndex?: number): SyncError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { operation, message, rowIndex, cause };
}

async function reportProgress(config: SyncConfig, progress: SyncProgress): Promise<void> {
  if (config.onProgress) await config.onProgress(progress);
}

function isDatabaseRow(value: unknown): value is DatabaseRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    // Normalise arbitrary Error reasons so callers (and the HTTP layer) can
    // reliably identify cancellation without losing the original message.
    if (reason.name === 'AbortError') throw reason;
    const error = new Error(reason.message || 'Synchronization aborted.');
    error.name = 'AbortError';
    throw error;
  }
  const error = new Error(typeof reason === 'string' ? reason : 'Synchronization aborted.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

/**
 * Read existing records from a full client or a minimal host fake that only
 * implements one-page `listRecords`.  Keeping this compatibility layer here
 * makes the sync engine useful with lightweight connectors and older plugin
 * hosts while retaining the normal FeishuClient fast path.
 */
async function listAllRecordsCompat(
  client: FeishuClientLike,
  appToken: string,
  tableId: string,
  options: Record<string, unknown> & { signal?: AbortSignal },
): Promise<FeishuRecord[]> {
  const extended = client as FeishuClientLike & {
    listAllRecords?: (
      app: string,
      table: string,
      options?: Record<string, unknown>,
    ) => Promise<FeishuRecord[]>;
  };
  if (typeof extended.listAllRecords === 'function') {
    const records = await extended.listAllRecords(appToken, tableId, options);
    // A few older connectors expose a method with this name but return a
    // single-page envelope. Only accept the documented array shape here; if
    // it is not an array, fall through to the one-page compatibility loop so
    // records are not silently treated as an empty table.
    if (Array.isArray(records)) return records.filter(isDatabaseRow) as FeishuRecord[];
  }
  const listPage = typeof client.listRecords === 'function'
    ? client.listRecords.bind(client)
    : typeof client.searchRecords === 'function'
      ? client.searchRecords.bind(client)
      : undefined;
  if (!listPage) {
    throw new Error('Feishu client must implement listAllRecords, listRecords, or searchRecords for upsert mode');
  }
  const records: FeishuRecord[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined = typeof options.pageToken === 'string' && options.pageToken
    ? options.pageToken
    : undefined;
  for (let page = 0; page < 100_000; page += 1) {
    throwIfAborted(options.signal);
    const result = await listPage(appToken, tableId, { ...options, pageToken });
    if (Array.isArray(result)) {
      records.push(...result.filter(isDatabaseRow) as FeishuRecord[]);
      return records;
    }
    const pageObject = result as unknown as Record<string, unknown> | undefined;
    const nested = pageObject && typeof pageObject.data === 'object' && pageObject.data !== null && !Array.isArray(pageObject.data)
      ? pageObject.data as Record<string, unknown>
      : undefined;
    const pageItems = pageObject?.items ?? pageObject?.records ?? nested?.items ?? nested?.records;
    if (Array.isArray(pageItems)) records.push(...pageItems.filter(isDatabaseRow) as FeishuRecord[]);
    const hasMore = Boolean(pageObject?.hasMore ?? pageObject?.has_more ?? nested?.hasMore ?? nested?.has_more);
    const rawNextToken = pageObject?.pageToken ?? pageObject?.page_token ?? nested?.pageToken ?? nested?.page_token;
    const nextToken = rawNextToken === undefined || rawNextToken === null ? '' : String(rawNextToken);
    if (!hasMore || !nextToken) return records;
    if (seenTokens.has(nextToken)) throw new Error('Feishu pagination returned a repeated page token');
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new Error('Feishu pagination exceeded the safety limit');
}
