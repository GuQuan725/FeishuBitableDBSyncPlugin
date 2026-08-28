import {
  BitableFieldValue,
  FeishuApiError,
  FeishuBatchResult,
  FeishuCreateRecordInput,
  FeishuUpdateRecordInput,
  FeishuClientLike,
  FeishuClientOptions,
  FeishuRecord,
  FeishuRecordPage,
  FeishuField,
  FeishuTable,
  FeishuRequestOptions,
  FetchLike,
  RetryOptions,
  RecordSearchOptions,
  TenantAccessTokenOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const MAX_BATCH_SIZE = 500;
// Feishu's table/field collection endpoints have a lower page-size cap than
// the records batch/list APIs. Keep this separate from MAX_BATCH_SIZE so a
// caller asking for a large page cannot receive an avoidable 400 from Feishu.
const MAX_COLLECTION_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY = 300;
const DEFAULT_MAX_DELAY = 10_000;

interface ApiEnvelope {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitter: number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface TenantAccessToken {
  token: string;
  expire?: number;
  raw?: unknown;
}

/**
 * Small, dependency-free Feishu Open API client. `fetch` is injectable, which
 * keeps this class usable in unit tests and in hosts that already have an HTTP
 * proxy/client configured.
 */
export class FeishuClient implements FeishuClientLike {
  readonly baseUrl: string;
  readonly accessToken?: string;

  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retry: RetryConfig;
  private readonly signal?: AbortSignal;

  constructor(options: FeishuClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.accessToken = options.accessToken || options.tenantAccessToken || options.token;
    this.fetchImpl = options.fetch || getGlobalFetch();
    this.defaultHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    this.retry = {
      maxRetries: normalizeNonNegative(options.maxRetries, DEFAULT_MAX_RETRIES),
      initialDelayMs: normalizeNonNegative(options.initialDelayMs, DEFAULT_INITIAL_DELAY),
      maxDelayMs: normalizeNonNegative(options.maxDelayMs, DEFAULT_MAX_DELAY),
      backoffFactor: options.backoffFactor !== undefined && options.backoffFactor > 0 ? options.backoffFactor : 2,
      jitter: options.jitter !== undefined && options.jitter >= 0 ? options.jitter : 0.1,
      sleep: options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
    this.signal = options.signal;
  }

  /** List tables in a Bitable app for the configuration UI. */
  async listTables(
    appToken: string,
    options: { pageSize?: number; pageToken?: string; signal?: AbortSignal } = {},
  ): Promise<{ items: FeishuTable[]; hasMore: boolean; pageToken?: string; total?: number }> {
    return this.listCollection(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      options,
    );
  }

  /** List fields for a Bitable table for the mapping UI. */
  async listFields(
    appToken: string,
    tableId: string,
    options: { pageSize?: number; pageToken?: string; signal?: AbortSignal } = {},
  ): Promise<{ items: FeishuField[]; hasMore: boolean; pageToken?: string; total?: number }> {
    return this.listCollection(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      options,
    );
  }

  async listAllTables(appToken: string, options: { pageSize?: number; signal?: AbortSignal } = {}): Promise<FeishuTable[]> {
    return this.listAllCollection((pageToken) => this.listTables(appToken, { ...options, pageToken }), options.signal);
  }

  async listAllFields(appToken: string, tableId: string, options: { pageSize?: number; signal?: AbortSignal } = {}): Promise<FeishuField[]> {
    return this.listAllCollection((pageToken) => this.listFields(appToken, tableId, { ...options, pageToken }), options.signal);
  }

  /** Build a client after obtaining a tenant token with app credentials. */
  static async createWithAppCredentials(options: TenantAccessTokenOptions): Promise<FeishuClient> {
    const token = await fetchTenantAccessToken(options);
    return new FeishuClient({
      ...options,
      accessToken: token.token,
    });
  }

  async listRecords(
    appToken: string,
    tableId: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      filter?: string | Record<string, unknown>;
      fieldNames?: string[];
      sort?: unknown[];
      automaticFields?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<FeishuRecordPage> {
    const query = new URLSearchParams();
    query.set('page_size', String(clampPageSize(options.pageSize)));
    if (options.pageToken) query.set('page_token', options.pageToken);
    if (options.filter) query.set('filter', typeof options.filter === 'string' ? options.filter : JSON.stringify(options.filter));
    if (options.fieldNames?.length) query.set('field_names', JSON.stringify(options.fieldNames));
    if (options.sort?.length) query.set('sort', JSON.stringify(options.sort));
    if (options.automaticFields !== undefined) query.set('automatic_fields', String(options.automaticFields));

    const envelope = await this.request<ApiEnvelope>(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query.toString()}`,
      undefined,
      { signal: options.signal },
    );
    const data = responseData(envelope);
    const items = asArray(data.items ?? data.records).map(normalizeRecord);
    const hasMore = Boolean(data.has_more ?? data.hasMore);
    const pageToken = asString(data.page_token ?? data.pageToken);
    const total = asNumber(data.total);
    return { items, hasMore, pageToken: pageToken || undefined, total };
  }

  /** Alias matching Feishu's search-records terminology. */
  async searchRecords(
    appToken: string,
    tableId: string,
    options: RecordSearchOptions = {},
  ): Promise<FeishuRecordPage> {
    return this.listRecords(appToken, tableId, options);
  }

  async listAllRecords(
    appToken: string,
    tableId: string,
    options: RecordSearchOptions = {},
  ): Promise<FeishuRecord[]> {
    const records: FeishuRecord[] = [];
    // Honour an initial page token supplied by callers (useful when a sync
    // job resumes a previously interrupted scan).
    let pageToken: string | undefined = options.pageToken;
    const seenTokens = new Set<string>();
    // The guard prevents a broken proxy/API from causing an infinite loop.
    for (let page = 0; page < 100_000; page += 1) {
      throwIfAborted(options.signal || this.signal);
      const result = await this.listRecords(appToken, tableId, { ...options, pageToken });
      records.push(...result.items);
      if (!result.hasMore || !result.pageToken) return records;
      if (seenTokens.has(result.pageToken)) {
        throw new FeishuApiError('Feishu pagination returned a repeated page token', {
          response: result,
          retryable: false,
        });
      }
      seenTokens.add(result.pageToken);
      pageToken = result.pageToken;
    }
    throw new FeishuApiError('Feishu pagination exceeded the safety limit', { retryable: false });
  }

  async batchCreateRecords(
    appToken: string,
    tableId: string,
    records: Array<{ fields: Record<string, BitableFieldValue> }>,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<FeishuBatchResult[]> {
    return this.batchRequest('create', appToken, tableId, records, options);
  }

  async batchUpdateRecords(
    appToken: string,
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, BitableFieldValue> }>,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<FeishuBatchResult[]> {
    return this.batchRequest('update', appToken, tableId, records, options);
  }

  /** Concise aliases for integrations that call these operations directly. */
  async createRecords(
    appToken: string,
    tableId: string,
    records: Array<{ fields: Record<string, BitableFieldValue> }>,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<FeishuBatchResult[]> {
    return this.batchCreateRecords(appToken, tableId, records, options);
  }

  async updateRecords(
    appToken: string,
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, BitableFieldValue> }>,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<FeishuBatchResult[]> {
    return this.batchUpdateRecords(appToken, tableId, records, options);
  }

  /** Public low-level request helper for advanced endpoints and tests. */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: FeishuRequestOptions = {},
  ): Promise<T> {
    const url = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = { ...this.defaultHeaders };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const maxRetries = options.noRetry
      ? 0
      : normalizeNonNegative(options.maxRetries, this.retry.maxRetries);
    const signal = options.signal || this.signal;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(signal);
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        // A custom fetch implementation may ignore AbortSignal.  Check it
        // explicitly before parsing/returning a response so cancellation is
        // still deterministic in tests and embedded hosts.
        throwIfAborted(signal);
        const payload = await parseBody(response);
        throwIfAborted(signal);
        const envelope = isObject(payload) ? (payload as ApiEnvelope) : undefined;
        const code = envelope?.code;
        const httpOk = response.ok ?? (response.status >= 200 && response.status < 300);
        const failed = !httpOk || (code !== undefined && String(code) !== '0');
        if (!failed) return (envelope?.data === undefined ? payload : envelope) as T;

        const retryable = isRetryableStatus(response.status) || isRetryableCode(code);
        const error = new FeishuApiError(
          envelope?.msg || envelope?.message || response.statusText || `Feishu API request failed (${response.status})`,
          {
            status: response.status,
            // Preserve symbolic error codes (some gateways return strings)
            // while retaining numeric codes exactly as supplied by Feishu.
            code: typeof code === 'number' || typeof code === 'string' ? code : undefined,
            requestId: getRequestId(response),
            response: payload,
            retryable,
          },
        );
        lastError = error;
        if (!retryable || attempt >= maxRetries) throw error;
        await sleepWithSignal(this.retry.sleep, retryDelay(attempt, response, this.retry), signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        lastError = error;
        const retryable = error instanceof FeishuApiError ? error.retryable : true;
        if (!retryable || attempt >= maxRetries) {
          if (error instanceof FeishuApiError) throw error;
          throw new FeishuApiError(error instanceof Error ? error.message : String(error), {
            retryable: false,
            cause: error,
          });
        }
        await sleepWithSignal(this.retry.sleep, retryDelay(attempt, undefined, this.retry), signal);
      }
    }
    throw lastError instanceof Error ? lastError : new FeishuApiError('Feishu API request failed');
  }

  /** Request helper that unwraps the conventional Feishu `data` envelope. */
  async requestData<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: FeishuRequestOptions = {},
  ): Promise<T> {
    const payload = await this.request<ApiEnvelope>(method, path, body, options);
    return (isObject(payload) && (payload as ApiEnvelope).data !== undefined
      ? (payload as ApiEnvelope).data
      : payload) as T;
  }

  private async batchRequest(
    operation: 'create' | 'update',
    appToken: string,
    tableId: string,
    records: Array<FeishuCreateRecordInput | FeishuUpdateRecordInput>,
    options: { batchSize?: number; signal?: AbortSignal },
  ): Promise<FeishuBatchResult[]> {
    if (records.length === 0) return [];
    const batchSize = clampBatchSize(options.batchSize);
    const path = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${operation === 'create' ? 'batch_create' : 'batch_update'}`;
    const results: FeishuBatchResult[] = [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const chunk = records.slice(offset, offset + batchSize);
      const envelope = await this.request<ApiEnvelope>(
        'POST',
        path,
        { records: chunk },
        { signal: options.signal },
      );
      const data = responseData(envelope);
      const resultRecords = asArray(data.records ?? data.items).map(normalizeRecord);
      results.push({ records: resultRecords, raw: envelope });
    }
    return results;
  }

  private async listCollection(
    path: string,
    options: { pageSize?: number; pageToken?: string; signal?: AbortSignal },
  ): Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; pageToken?: string; total?: number }> {
    const query = new URLSearchParams({ page_size: String(clampCollectionPageSize(options.pageSize)) });
    if (options.pageToken) query.set('page_token', options.pageToken);
    const envelope = await this.request<ApiEnvelope>('GET', `${path}?${query.toString()}`, undefined, { signal: options.signal });
    const data = responseData(envelope);
    const items = asArray(data.items ?? data.tables ?? data.fields).filter(isObject) as Array<Record<string, unknown>>;
    return {
      items,
      hasMore: Boolean(data.has_more ?? data.hasMore),
      pageToken: asString(data.page_token ?? data.pageToken) || undefined,
      total: asNumber(data.total),
    };
  }

  private async listAllCollection(
    fetchPage: (pageToken?: string) => Promise<{ items: Array<Record<string, unknown>>; hasMore: boolean; pageToken?: string }>,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let token: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      throwIfAborted(signal || this.signal);
      const page = await fetchPage(token);
      items.push(...page.items);
      if (!page.hasMore || !page.pageToken) return items;
      if (seen.has(page.pageToken)) throw new FeishuApiError('Feishu pagination returned a repeated page token');
      seen.add(page.pageToken);
      token = page.pageToken;
    }
    throw new FeishuApiError('Feishu pagination exceeded the safety limit');
  }
}

/** Backwards-compatible alias used by some callers. */
export const FeishuBitableClient = FeishuClient;

/** Fetch a tenant token without requiring a Feishu SDK. */
export async function fetchTenantAccessToken(
  options: TenantAccessTokenOptions,
): Promise<TenantAccessToken> {
  if (!options.appId?.trim() || !options.appSecret?.trim()) {
    throw new FeishuApiError('appId and appSecret are required to obtain a tenant access token');
  }
  const client = new FeishuClient({
    ...options,
    // This endpoint must not receive an old/ambient bearer token.
    accessToken: undefined,
    tenantAccessToken: undefined,
  });
  const payload = await client.request<ApiEnvelope>(
    'POST',
    '/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: options.appId, app_secret: options.appSecret },
  );
  // The auth endpoint historically returned token fields at the top level;
  // some gateways wrap them in `data`. Support both response shapes.
  const data = { ...asObject(payload), ...asObject(asObject(payload).data) };
  const token = asString(data.tenant_access_token ?? data.tenantAccessToken);
  if (!token) throw new FeishuApiError('Feishu did not return a tenant access token', { response: payload });
  return { token, expire: asNumber(data.expire), raw: payload };
}

function getGlobalFetch(): FetchLike {
  const candidate = (globalThis as unknown as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error('No fetch implementation available; pass fetch in FeishuClient options');
  }
  return candidate as FetchLike;
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(value as number)));
}

function clampCollectionPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_COLLECTION_PAGE_SIZE, Math.floor(value as number)));
}

function clampBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(value as number)));
}

function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableCode(code: number | string | undefined): boolean {
  if (code === undefined) return false;
  const text = String(code).toLowerCase();
  return text.includes('rate') || text.includes('throttle') || text === '99991400' || text === '1254290';
}

function retryDelay(
  attempt: number,
  response: { headers?: unknown } | undefined,
  retry: RetryConfig,
): number {
  const retryAfter = getHeader(response?.headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(retry.maxDelayMs, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(retry.maxDelayMs, Math.max(0, date - Date.now()));
  }
  const base = Math.min(retry.maxDelayMs, retry.initialDelayMs * Math.pow(retry.backoffFactor, attempt));
  const randomPart = retry.jitter > 0 ? base * retry.jitter * Math.random() : 0;
  return Math.min(retry.maxDelayMs, Math.round(base + randomPart));
}

async function parseBody(response: { json(): Promise<unknown>; text?(): Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.text) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return undefined;
  }
}

function getRequestId(response: { headers?: unknown }): string | undefined {
  return getHeader(response.headers, 'x-request-id') || getHeader(response.headers, 'x-tt-logid') || undefined;
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name);
  }
  if (typeof headers === 'object') {
    const entries = headers as Record<string, unknown>;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(entries)) {
      if (key.toLowerCase() === wanted && value !== undefined && value !== null) return String(value);
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, any> {
  return isObject(value) ? (value as Record<string, any>) : {};
}

/** Normalize Feishu responses whose useful payload may be under `data` or at
 * the top level (the latter is used by a few legacy endpoints). */
function responseData(envelope: unknown): Record<string, any> {
  const object = asObject(envelope);
  const nested = asObject(object.data);
  if (Object.keys(nested).length > 0) return nested;
  return object;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecord(value: unknown): FeishuRecord {
  if (!isObject(value)) return { fields: {} };
  const record = value as Record<string, unknown>;
  const fields = isObject(record.fields) ? (record.fields as Record<string, BitableFieldValue>) : {};
  return {
    ...record,
    fields,
    record_id: asString(record.record_id ?? record.recordId),
  };
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (isAbortError(reason)) throw reason;
  const error = new Error(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Feishu request aborted.');
  error.name = 'AbortError';
  throw error;
}

/** Make retry backoff cancellable even when a host supplies a plain sleep fn. */
async function sleepWithSignal(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      const error = new Error('Feishu request aborted.');
      error.name = 'AbortError';
      finish(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // The injected sleep may not be timer-based (tests often resolve it
    // immediately), so race it manually and ignore a late completion after
    // cancellation. Start it through a microtask so a host implementation
    // that throws synchronously is handled by `finish` too; this also removes
    // the abort listener instead of leaving it attached indefinitely.
    void Promise.resolve()
      .then(() => sleep(milliseconds))
      .then(() => finish(), (error) => finish(error));
    if (signal.aborted) onAbort();
  });
}
