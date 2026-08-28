import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, type StoredConnection, type StoredQueryParam, type SyncConfigRecord, type SyncRunRecord } from './store.js';
import { decryptSecret, encryptSecret, isEncryptedSecret, redactSecrets } from './security.js';
import {
  createDatabaseAdapter,
  type DatabaseAdapter,
  type AdapterDependencies,
  type DatabaseConnectionConfig,
  type DatabaseType,
  DatabaseAdapterError,
  DatabaseConfigError,
  DatabaseDependencyError,
  ReadOnlyQueryError,
  assertSafeSql,
  normalizeDatabaseType,
  quoteIdentifierPath,
  redactConnectionConfig,
} from './db/index.js';
import {
  BitableSyncService,
  FeishuClient,
  FeishuApiError,
  MappingError,
  type DatabaseRow,
  type FeishuClientLike,
  type SyncConfig,
} from './sync/index.js';
import { normalizeMappings } from './sync/field-mapping.js';

export interface AppServerOptions {
  host: string;
  port: number;
  store: JsonStore;
  encryptionKey: string;
  feishuBaseUrl?: string;
  adminToken?: string;
  /** Optional driver injection for tests or host runtimes. */
  adapterDependencies?: AdapterDependencies;
  /** Optional Feishu client factory for proxies and deterministic tests. */
  feishuClientFactory?: (credentials: { appId: string; appSecret: string }) => Promise<FeishuClientLike>;
  publicDir?: string;
}

interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  url: URL;
}

interface JsonBody {
  [key: string]: unknown;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Dependency-free HTTP application. It intentionally uses Node's built-in
 * server so the plugin can be embedded in Feishu/Lark extensions without an
 * additional web framework.
 */
export class AppServer {
  private readonly server;
  private readonly abortControllers = new Map<string, AbortController>();
  /** Detached sync workers must be awaited during shutdown so their database
   * adapters (and any other connector resources) are released before callers
   * remove temporary files or terminate the host process. */
  private readonly syncWorkers = new Set<Promise<void>>();
  private readonly publicDir: string;

  constructor(private readonly options: AppServerOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.publicDir = options.publicDir || findPublicDir();
  }

  async listen(): Promise<void> {
    await this.options.store.load();
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolvePromise();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.port, this.options.host);
    });
  }

  address(): { host: string; port: number } {
    const address = this.server.address();
    if (!address || typeof address === 'string') return { host: this.options.host, port: this.options.port };
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    // Abort detached workers immediately. Existing requests may still finish
    // and enqueue a worker while `server.close` waits, so we drain workers in
    // a loop below rather than taking only one snapshot.
    for (const controller of this.abortControllers.values()) controller.abort();
    await new Promise<void>((resolvePromise, reject) => {
      if (!this.server.listening) return resolvePromise();
      this.server.close((error) => error ? reject(error) : resolvePromise());
    });
    while (this.syncWorkers.size > 0) {
      for (const controller of this.abortControllers.values()) controller.abort();
      const workers = [...this.syncWorkers];
      await Promise.allSettled(workers);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCorsHeaders(response);
    if (request.method === 'OPTIONS') return endResponse(response, 204);
    try {
      // Routing only needs the request target path.  Using a fixed valid base
      // avoids malformed/untrusted Host headers causing an uncaught URL parse
      // exception before the normal API error handler runs.
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/') && this.options.adminToken && !isAuthorized(request, this.options.adminToken)) {
        return sendJson(response, 401, { error: '未授权：请提供有效的管理令牌' });
      }
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi({ request, response, params: {}, url });
      } else {
        await this.serveStatic(url.pathname, response);
      }
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private async handleApi(context: RouteContext): Promise<void> {
    const { request, response, url } = context;
    const method = request.method || 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/api/health') {
      return sendJson(response, 200, { ok: true, service: 'feishu-bitable-db-sync', time: new Date().toISOString() });
    }
    if (method === 'GET' && path === '/api/meta') {
      return sendJson(response, 200, {
        databaseTypes: [
          { value: 'postgres', label: 'PostgreSQL', driver: 'pg', aliases: ['postgresql', 'pg'] },
          { value: 'mysql', label: 'MySQL / MariaDB', driver: 'mysql2', aliases: ['mysql2', 'mariadb'] },
          { value: 'sqlite', label: 'SQLite', driver: 'better-sqlite3 / sqlite3 / node:sqlite', aliases: ['sqlite3'] },
        ],
        transforms: ['auto', 'text', 'number', 'date', 'boolean', 'json'],
        limits: { feishuBatchSize: 500, maxPageSize: 5000 },
      });
    }

    if (method === 'GET' && path === '/api/connections') return this.listConnections(response);
    if (method === 'POST' && path === '/api/connections') return this.createConnection(request, response);
    if (method === 'POST' && path === '/api/connections/test') return this.testConnection(request, response);
    const connectionMatch = /^\/api\/connections\/([^/]+)(?:\/tables\/([^/]+)\/columns|\/tables|\/preview)?$/.exec(path);
    if (connectionMatch) {
      const connectionId = decodePathPart(connectionMatch[1]);
      if (method === 'DELETE' && !connectionMatch[2] && path === `/api/connections/${connectionMatch[1]}`) {
        return this.deleteConnection(connectionId, response);
      }
      if (method === 'GET' && connectionMatch[2]) return this.describeConnectionTable(connectionId, decodePathPart(connectionMatch[2]), response);
      if (method === 'GET' && path.endsWith('/tables')) return this.listConnectionTables(connectionId, response);
      if (method === 'GET' && path.endsWith('/preview')) return this.previewConnectionTable(connectionId, url, response);
    }
    // The expression above intentionally keeps table identifiers URL-encoded;
    // this explicit fallback handles DELETE paths without an optional suffix.
    const deleteMatch = /^\/api\/connections\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && deleteMatch) return this.deleteConnection(decodePathPart(deleteMatch[1]), response);

    if (method === 'POST' && path === '/api/feishu/tables') return this.listFeishuTables(request, response);
    if (method === 'POST' && path === '/api/feishu/fields') return this.listFeishuFields(request, response);

    if (method === 'GET' && path === '/api/sync-configs') return sendJson(response, 200, await this.publicSyncConfigs());
    if (method === 'POST' && path === '/api/sync-configs') return this.createSyncConfig(request, response);
    const syncConfigMatch = /^\/api\/sync-configs\/([^/]+)$/.exec(path);
    if (method === 'GET' && syncConfigMatch) return this.getSyncConfig(decodePathPart(syncConfigMatch[1]), response);
    if (method === 'DELETE' && syncConfigMatch) return this.deleteSyncConfig(decodePathPart(syncConfigMatch[1]), response);

    if (method === 'GET' && path === '/api/sync-runs') {
      return sendJson(response, 200, await this.options.store.listSyncRuns(url.searchParams.get('configId') || undefined));
    }
    if (method === 'POST' && path === '/api/sync-runs') return this.createSyncRun(request, response);
    const syncRunMatch = /^\/api\/sync-runs\/([^/]+)(?:\/cancel)?$/.exec(path);
    if (syncRunMatch) {
      const runId = decodePathPart(syncRunMatch[1]);
      if (method === 'GET') return this.getSyncRun(runId, response);
      if (method === 'POST' && path.endsWith('/cancel')) return this.cancelSyncRun(runId, response);
    }

    sendJson(response, 404, { error: 'Not found' });
  }

  private async listConnections(response: ServerResponse): Promise<void> {
    const connections = await this.options.store.listConnections();
    sendJson(response, 200, connections.map((connection) => this.publicConnection(connection)));
  }

  private async createConnection(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const rawConfig = isObject(body.config) ? body.config : body;
    const existingId = optionalString(body.id);
    const existing = existingId ? await this.options.store.getConnection(existingId) : undefined;
    if (existingId && !existing) {
      return sendJson(response, 404, { error: '数据库连接不存在' });
    }
    const name = optionalString(body.name) || existing?.name;
    if (!name) throw new HttpError(400, '连接名称不能为空');
    // On edits, type may be omitted because the existing profile already
    // defines it. A supplied body/config value still takes precedence.
    const type = parseDatabaseType(body.type ?? rawConfig.type ?? existing?.type);
    const oldConfig = existing ? decryptDatabaseConfig(existing.config, this.options.encryptionKey) : {};
    const plainConfig = mergeDefined(oldConfig, rawConfig) as unknown as DatabaseConnectionConfig;
    // The type may be supplied either at the request envelope level or inside
    // `config`.  `mergeDefined` intentionally omits envelope-only keys, so
    // assign the already-normalized value explicitly instead of attempting to
    // parse `body.type` a second time (which would reject a valid nested
    // `config.type`).
    plainConfig.type = type;
    const config = protectDatabaseConfig(plainConfig, this.options.encryptionKey);
    // Test before persisting, so a typo cannot create a broken profile.
    await this.withAdapter(plainConfig, async (adapter) => {
      await adapter.connect();
      return adapter.listTables();
    });
    const saved = await this.options.store.upsertConnection({ id: existingId, createdAt: existing?.createdAt, name, type, config });
    sendJson(response, existing ? 200 : 201, this.publicConnection(saved));
  }

  private async testConnection(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const rawConfig = isObject(body.config) ? body.config : body;
    const plainConfig = rawConfig as unknown as DatabaseConnectionConfig;
    plainConfig.type = parseDatabaseType(plainConfig.type ?? body.type);
    protectDatabaseConfig(plainConfig, this.options.encryptionKey);
    const tables = await this.withAdapter(plainConfig, async (adapter) => {
      await adapter.connect();
      return adapter.listTables();
    });
    sendJson(response, 200, { ok: true, tables: tables.slice(0, 100), count: tables.length });
  }

  private async deleteConnection(id: string, response: ServerResponse): Promise<void> {
    const deleted = await this.options.store.deleteConnection(id);
    if (!deleted) return sendJson(response, 404, { error: '连接不存在' });
    sendJson(response, 200, { deleted: true });
  }

  private async listConnectionTables(id: string, response: ServerResponse): Promise<void> {
    const connection = await this.requireConnection(id);
    const tables = await this.withStoredAdapter(connection, (adapter) => adapter.listTables());
    sendJson(response, 200, tables);
  }

  private async describeConnectionTable(id: string, table: string, response: ServerResponse): Promise<void> {
    const connection = await this.requireConnection(id);
    const [schema, tableName] = splitTableName(table);
    const columns = await this.withStoredAdapter(connection, (adapter) => adapter.describeTable(tableName, schema));
    sendJson(response, 200, columns);
  }

  private async previewConnectionTable(id: string, url: URL, response: ServerResponse): Promise<void> {
    const table = requiredString(url.searchParams.get('table'), '源数据表');
    const limit = boundedNumber(url.searchParams.get('limit'), 10, 1, 100);
    const connection = await this.requireConnection(id);
    const [schema, tableName] = splitTableName(table);
    const rows = await this.withStoredAdapter(connection, async (adapter) => {
      const result = await adapter.readTable<DatabaseRow>(tableName, { schema, limit });
      return result.rows;
    });
    sendJson(response, 200, rows);
  }

  private async listFeishuTables(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const appToken = requiredString(body.appToken, 'App Token');
    const client = await this.createFeishuClient(body);
    const tables = await listAllFeishuTables(client, appToken);
    sendJson(response, 200, tables.map(normalizeFeishuTable));
  }

  private async listFeishuFields(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const appToken = requiredString(body.appToken, 'App Token');
    const tableId = requiredString(body.tableId, '数据表 ID');
    const client = await this.createFeishuClient(body);
    const fields = await listAllFeishuFields(client, appToken, tableId);
    sendJson(response, 200, fields.map(normalizeFeishuField));
  }

  private async createSyncConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const connectionId = requiredString(body.connectionId, '数据库连接');
    const sourceConnection = await this.requireConnection(connectionId);
    const source = isObject(body.source) ? body.source : {};
    const target = isObject(body.target) ? body.target : {};
    const auth = isObject(target.auth) ? target.auth : {};
    const mappings = Array.isArray(body.mappings) ? body.mappings : [];
    let normalizedMappings: ReturnType<typeof normalizeMappings>;
    try {
      normalizedMappings = normalizeMappings(mappings as never[]);
    } catch (error) {
      throw new HttpError(400, safeErrorMessage(error));
    }
    const optionsInput = isObject(body.options) ? body.options : {};
    const requestedMode = optionsInput.mode === undefined || optionsInput.mode === null || optionsInput.mode === ''
      ? 'upsert'
      : String(optionsInput.mode).trim().toLowerCase();
    if (requestedMode !== 'append' && requestedMode !== 'upsert') {
      throw new HttpError(400, '同步模式必须是 append 或 upsert');
    }
    const mode = requestedMode as 'append' | 'upsert';
    const table = optionalString(source.table);
    const schema = optionalString(source.schema);
    const query = optionalString(source.query);
    if (!table && !query) {
      throw new HttpError(400, '请提供源数据表或自定义查询');
    }
    if (table) {
      try {
        // Validate the identifier before persisting the config. The adapter
        // quotes it again at execution time, but early validation avoids
        // saving a job that can only fail later (and keeps all dialects on
        // the same identifier rules).
        quoteIdentifierPath(table, sourceConnection.type);
      } catch (error) {
        throw new HttpError(400, safeErrorMessage(error));
      }
    }
    if (schema && !table) {
      throw new HttpError(400, '仅使用自定义查询时不能填写 schema');
    }
    if (schema && table?.includes('.')) {
      throw new HttpError(400, '源数据表已包含 schema 时不能再单独填写 schema');
    }
    if (query) {
      try {
        assertSafeSql(query, true);
      } catch (error) {
        throw new HttpError(400, safeErrorMessage(error));
      }
    }
    const queryParams = normalizeQueryParams(source.params ?? source.queryParams);
    const appToken = requiredString(target.appToken, '多维表格 App Token');
    const tableId = requiredString(target.tableId, '数据表 ID');
    const appId = requiredString(auth.appId, '飞书 App ID');
    const appSecretInput = requiredString(auth.appSecret, '飞书 App Secret');
    const keyField = optionalString(optionsInput.keyField);
    if (mode === 'upsert' && !keyField) throw new HttpError(400, '更新或新增模式必须选择唯一键');
    const now = new Date().toISOString();
    const existingId = optionalString(body.id);
    const existing = existingId ? await this.options.store.getSyncConfig(existingId) : undefined;
    if (existingId && !existing) {
      return sendJson(response, 404, { error: '同步配置不存在' });
    }
    if (keyField) {
      const keyMapping = normalizedMappings.find((mapping) => mapping.source === keyField || mapping.target === keyField);
      if (!keyMapping) {
        throw new HttpError(400, `唯一键必须匹配字段映射中的源字段或目标字段：${keyField}`);
      }
    }
    const existingSecret = existing?.target?.auth?.appSecret;
    let appSecret: string;
    if (appSecretInput === '********') {
      if (typeof existingSecret !== 'string' || !existingSecret || existingSecret === '********') {
        throw new HttpError(400, '请提供真实的飞书 App Secret（无法使用占位符创建配置）');
      }
      // Re-encrypt legacy plaintext values when an old store predates
      // credential protection; current ciphertext is retained verbatim.
      appSecret = isEncryptedSecret(existingSecret)
        ? existingSecret
        : encryptSecret(existingSecret, this.options.encryptionKey);
    } else {
      appSecret = encryptSecret(appSecretInput, this.options.encryptionKey);
    }
    const record = await this.options.store.upsertSyncConfig({
      id: existingId,
      createdAt: existing?.createdAt || now,
      name: optionalString(body.name) || `${connectionId} → ${tableId}`,
      connectionId,
      source: { table, schema, query, params: queryParams },
      target: { appToken, tableId, auth: { appId, appSecret } },
      mappings: mappings as SyncConfigRecord['mappings'],
      options: {
        mode,
        keyField,
        batchSize: boundedNumber(optionsInput.batchSize, 500, 1, 500),
        pageSize: boundedNumber(optionsInput.pageSize, 500, 1, 5000),
        dryRun: parseBoolean(optionsInput.dryRun, 'dryRun', false),
      },
      enabled: parseBoolean(body.enabled, 'enabled', true),
    });
    sendJson(response, existing ? 200 : 201, this.publicSyncConfig(record));
  }

  private async getSyncConfig(id: string, response: ServerResponse): Promise<void> {
    const config = await this.options.store.getSyncConfig(id);
    if (!config) return sendJson(response, 404, { error: '同步配置不存在' });
    sendJson(response, 200, this.publicSyncConfig(config));
  }

  private async deleteSyncConfig(id: string, response: ServerResponse): Promise<void> {
    // Keep deletion explicit and recoverable at the JSON-store level by only
    // disabling the config; historical run records remain available.
    const config = await this.options.store.getSyncConfig(id);
    if (!config) return sendJson(response, 404, { error: '同步配置不存在' });
    await this.options.store.upsertSyncConfig({ ...config, enabled: false });
    sendJson(response, 200, { deleted: true, disabled: true });
  }

  private async createSyncRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const configId = requiredString(body.configId, '同步配置');
    const config = await this.options.store.getSyncConfig(configId);
    if (!config) return sendJson(response, 404, { error: '同步配置不存在' });
    if (!config.enabled) return sendJson(response, 409, { error: '同步配置已停用' });
    const run = await this.options.store.createSyncRun(configId);
    // Return immediately; the actual work is intentionally detached from the
    // request so large tables do not hold an HTTP connection open.
    const controller = new AbortController();
    this.abortControllers.set(run.id, controller);
    const worker = this.executeSyncRun(run, config, controller);
    this.syncWorkers.add(worker);
    // executeSyncRun handles expected failures itself. Keep a defensive
    // rejection handler here so an unexpected programming error cannot become
    // an unhandled rejection during shutdown, and remove the worker from the
    // drain set once it settles.
    void worker.finally(() => this.syncWorkers.delete(worker)).catch(() => undefined);
    sendJson(response, 202, run);
  }

  private async getSyncRun(id: string, response: ServerResponse): Promise<void> {
    const run = await this.options.store.getSyncRun(id);
    if (!run) return sendJson(response, 404, { error: '同步任务不存在' });
    sendJson(response, 200, run);
  }

  private async cancelSyncRun(id: string, response: ServerResponse): Promise<void> {
    const existing = await this.options.store.getSyncRun(id);
    if (!existing) return sendJson(response, 404, { error: '同步任务不存在' });
    if (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'cancelled') {
      return sendJson(response, 409, { error: `任务已${existing.status === 'succeeded' ? '完成' : existing.status === 'failed' ? '失败' : '取消'}`, data: existing });
    }
    const controller = this.abortControllers.get(id);
    if (controller) controller.abort();
    // Conditional transition linearizes cancellation with the worker's final
    // success/failure update.  An unconditional write here could mark an
    // already-completed run as cancelled when both requests race.
    const run = await this.options.store.updateSyncRunIfStatus(
      id,
      ['queued', 'running'],
      { status: 'cancelled', finishedAt: new Date().toISOString() },
    );
    if (run) return sendJson(response, 200, run);
    const current = await this.options.store.getSyncRun(id);
    if (!current) return sendJson(response, 404, { error: '同步任务不存在' });
    if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') {
      return sendJson(response, 409, { error: `任务已${current.status === 'succeeded' ? '完成' : current.status === 'failed' ? '失败' : '取消'}`, data: current });
    }
    // A status changed between the reads (for example another cancellation)
    // but is still non-terminal; return the latest state without mutating it.
    sendJson(response, 200, current);
  }

  private async executeSyncRun(run: SyncRunRecord, record: SyncConfigRecord, controller: AbortController): Promise<void> {
    let adapter: DatabaseAdapter | undefined;
    try {
      const initial = await this.options.store.getSyncRun(run.id);
      if (initial?.status === 'cancelled' || controller.signal.aborted) {
        if (controller.signal.aborted && initial?.status !== 'cancelled') {
          // Server shutdown may abort a queued worker before it reaches the
          // normal catch/finally path. Persist the terminal state so a restart
          // does not leave a run falsely shown as queued.
          await this.options.store.updateSyncRunIfStatus(run.id, ['queued', 'running'], {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
          });
        }
        return;
      }
      // Claim the queued run atomically. The cancel endpoint can run while
      // this detached task is waiting on disk I/O; a failed claim means that
      // another actor already moved the run to a terminal/non-queued state.
      const started = await this.options.store.updateSyncRunIfStatus(
        run.id,
        'queued',
        {
          status: 'running',
          startedAt: new Date().toISOString(),
          logs: [`任务开始：${record.source.query ? '自定义查询' : record.source.table || '源数据表'}`],
        },
      );
      // Cancellation can arrive between the initial read and this status
      // transition. Do not open a database (or create a Feishu token) if it
      // won that race.
      if (!started || controller.signal.aborted) {
        if (controller.signal.aborted && started?.status === 'running') {
          await this.options.store.updateSyncRunIfStatus(run.id, 'running', {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
          });
        }
        return;
      }
      const connection = await this.requireConnection(record.connectionId);
      adapter = this.createAdapter(decryptDatabaseConfig(connection.config, this.options.encryptionKey));
      await adapter.connect();
      const auth = {
        appId: record.target.auth.appId,
        appSecret: isEncryptedSecret(record.target.auth.appSecret)
          ? decryptSecret(record.target.auth.appSecret, this.options.encryptionKey)
          : record.target.auth.appSecret,
      };
      const syncConfig: SyncConfig = {
        appToken: record.target.appToken,
        tableId: record.target.tableId,
        mappings: record.mappings as unknown as SyncConfig['mappings'],
        mode: record.options.mode,
        uniqueKey: record.options.keyField,
        batchSize: record.options.batchSize,
        pageSize: record.options.pageSize,
        dryRun: record.options.dryRun,
        skipInvalidRows: true,
        continueOnError: false,
        onProgress: async (progress) => {
          if (controller.signal.aborted) return;
          const current = await this.options.store.getSyncRun(run.id);
          if (!current || current.status === 'cancelled') return;
          // Use a conditional update so cancellation cannot race this
          // callback and leave progress/log writes attached to a terminal run.
          await this.options.store.updateSyncRunIfStatus(run.id, 'running', {
            writtenRows: (current?.writtenRows || 0) + progress.records,
            logs: [...(current?.logs || []), `${progress.operation === 'create' ? '新增' : '更新'} ${progress.records} 行`],
          });
        },
      };
      let client: FeishuClientLike;
      if (record.options.dryRun) {
        client = dryRunClient();
      } else if (this.options.feishuClientFactory) {
        // Allow embedders/tests to provide a proxy or deterministic client for
        // actual writes as well as metadata discovery.
        client = await this.options.feishuClientFactory({ appId: auth.appId, appSecret: auth.appSecret });
      } else {
        client = await FeishuClient.createWithAppCredentials({ appId: auth.appId, appSecret: auth.appSecret, baseUrl: this.options.feishuBaseUrl });
      }
      const sourceTable = record.source.table
        ? record.source.schema && !record.source.table.includes('.')
          ? `${record.source.schema}.${record.source.table}`
          : record.source.table
        : undefined;
      const rows = record.source.query
        ? (await adapter.query<DatabaseRow>(record.source.query, record.source.params || [], { signal: controller.signal })).rows
        : sourceTable
          ? adapter.iterateRows<DatabaseRow>(sourceTable, { pageSize: record.options.pageSize, signal: controller.signal })
          : (() => { throw new Error('同步配置缺少源数据表或自定义查询'); })();
      const result = await new BitableSyncService(client).sync(rows, syncConfig, controller.signal);
      const currentBeforeFinish = await this.options.store.getSyncRun(run.id);
      if (currentBeforeFinish?.status === 'cancelled' || controller.signal.aborted) return;
      const completed = await this.options.store.updateSyncRunIfStatus(run.id, 'running', {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        readRows: result.totalRows,
        writtenRows: result.created + result.updated,
        skippedRows: result.skipped,
        error: result.errors.length ? result.errors.map((item) => item.message).join('; ') : undefined,
        logs: [...(await this.options.store.getSyncRun(run.id))?.logs || [], `完成：读取 ${result.totalRows} 行，写入 ${result.created + result.updated} 行`],
      });
      // If cancellation won the race after the pre-finish read, the
      // conditional transition returns undefined and the cancelled state is
      // preserved.
      if (!completed) return;
    } catch (error) {
      const message = safeErrorMessage(error);
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const current = await this.options.store.getSyncRun(run.id);
      const expected: Array<'queued' | 'running'> = status === 'cancelled' ? ['queued', 'running'] : ['running'];
      await this.options.store.updateSyncRunIfStatus(run.id, expected, {
        status,
        finishedAt: new Date().toISOString(),
        error: message,
        logs: [...(current?.logs || []), `任务${status === 'cancelled' ? '取消' : '失败'}：${message}`],
      });
    } finally {
      this.abortControllers.delete(run.id);
      await adapter?.close().catch(() => undefined);
    }
  }

  private async createFeishuClient(body: JsonBody): Promise<FeishuClientLike> {
    const appId = requiredString(body.appId, '飞书 App ID');
    const appSecret = requiredString(body.appSecret, '飞书 App Secret');
    if (this.options.feishuClientFactory) return this.options.feishuClientFactory({ appId, appSecret });
    return FeishuClient.createWithAppCredentials({ appId, appSecret, baseUrl: this.options.feishuBaseUrl });
  }

  private async requireConnection(id: string): Promise<StoredConnection> {
    const connection = await this.options.store.getConnection(id);
    if (!connection) throw new HttpError(404, '数据库连接不存在');
    return connection;
  }

  private async withStoredAdapter<T>(connection: StoredConnection, operation: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const config = decryptDatabaseConfig(connection.config, this.options.encryptionKey);
    return this.withAdapter(config, operation);
  }

  private async withAdapter<T>(config: DatabaseConnectionConfig, operation: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const adapter = this.createAdapter(config);
    try {
      return await operation(adapter);
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }

  private createAdapter(config: DatabaseConnectionConfig): DatabaseAdapter {
    return createDatabaseAdapter(config, this.options.adapterDependencies);
  }

  private publicConnection(connection: StoredConnection): Record<string, unknown> {
    return { ...connection, config: redactSecrets(redactConnectionConfig(connection.config as unknown as DatabaseConnectionConfig)) };
  }

  private async publicSyncConfigs(): Promise<Record<string, unknown>[]> {
    const configs = await this.options.store.listSyncConfigs();
    return configs.map((config) => this.publicSyncConfig(config));
  }

  private publicSyncConfig(config: SyncConfigRecord): Record<string, unknown> {
    return {
      ...config,
      target: { ...config.target, auth: { appId: config.target.auth.appId, appSecret: '********' } },
    };
  }

  private sendError(response: ServerResponse, error: unknown): void {
    const status = error instanceof HttpError ? error.status : statusForError(error);
    sendJson(response, status, { error: safeErrorMessage(error) });
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const root = resolve(this.publicDir);
    const candidate = resolve(normalize(join(root, requested)));
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return sendJson(response, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(candidate);
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(data);
    } catch {
      if (requested !== '/index.html') return sendJson(response, 404, { error: 'Not found' });
      sendJson(response, 404, { error: 'UI resource not found' });
    }
  }
}

export function createAppServer(options: AppServerOptions): AppServer {
  return new AppServer(options);
}

function dirnameFromMeta(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

function findPublicDir(): string {
  const here = dirnameFromMeta();
  const candidates = [resolve(here, '../public'), resolve(here, '../../public')];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) || candidates[0];
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
}

function isAuthorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  // Constant-time comparison is unnecessary for a local admin token but a
  // length check avoids accidentally accepting a prefix.
  return token.length === expected.length && token === expected;
}

function endResponse(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  // Keep successful responses wrapped for a stable client contract; errors
  // are top-level so generic HTTP clients can read `error` without knowing
  // about the envelope.
  // Database drivers may expose BIGINT values as JavaScript bigint.  A
  // replacer keeps preview/API responses JSON-safe without losing the exact
  // decimal representation (and avoids mutating the source row).
  const payload = status >= 400 ? data : { data };
  response.end(JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? String(value) : value));
}

async function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求体必须是有效 JSON'); }
  if (!isObject(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return parsed;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

function requiredString(value: unknown, field: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new HttpError(400, `${field}不能为空`);
  return result;
}

function parseDatabaseType(value: unknown): DatabaseType {
  const input = requiredString(value, '数据库类型');
  try {
    return normalizeDatabaseType(input) as DatabaseType;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : '不支持的数据库类型');
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Parse an optional API boolean without relying on JavaScript truthiness. */
function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new HttpError(400, `${field}必须是布尔值`);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, '路径参数包含无效编码');
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `数值必须是 ${min} 到 ${max} 之间的整数`);
  return n;
}

/** Validate JSON query parameters before persisting or passing them to a DB driver. */
function normalizeQueryParams(value: unknown): StoredQueryParam[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, '查询参数必须是数组');
  return value.map((item, index) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    throw new HttpError(400, `查询参数第 ${index + 1} 项必须是字符串、数字、布尔值或 null`);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDefined(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  // Treat all DSN aliases as one logical field. This matters on edits: an
  // incoming `dsn`/`url` must replace an old canonical connectionString,
  // while a masked placeholder must leave the existing credential intact.
  const connectionString = usableCredentialPatch(patch.connectionString)
    ?? usableCredentialPatch(patch.dsn)
    ?? usableCredentialPatch(patch.url);
  for (const [key, value] of Object.entries(patch)) {
    // Request envelope fields are not database options. Undefined/empty
    // optional form values preserve an existing credential during edits.
    if (['name', 'id', 'config', 'type'].includes(key)) continue;
    if (['connectionString', 'dsn', 'url'].includes(key)) continue;
    // `options` and `ssl` are extensible nested objects. Merge them instead
    // of replacing the whole object so a redacted credential from a GET
    // response cannot overwrite the real value on an edit. Non-sensitive
    // nested values (including null/empty strings) are intentionally applied,
    // which lets clients clear an option explicitly.
    if (key === 'options' || key === 'ssl') {
      if (value === null) {
        delete result[key];
      } else if (isObject(value)) {
        result[key] = mergeNestedConfig(
          result[key],
          value,
          key === 'ssl' ? SSL_SECRET_FIELDS : DRIVER_OPTION_SECRET_FIELDS,
        );
      } else if (value !== undefined && value !== '') {
        result[key] = value;
      }
      continue;
    }
    if (
      value !== undefined &&
      value !== '' &&
      !(['password'].includes(key) && isSecretPlaceholder(value))
    ) result[key] = value;
  }
  if (connectionString !== undefined) {
    result.connectionString = connectionString;
    delete result.dsn;
    delete result.url;
  }
  return result;
}

function usableCredentialPatch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !isSecretPlaceholder(trimmed) ? trimmed : undefined;
}

/** Values emitted by the public redaction helpers and commonly used by UIs. */
function isSecretPlaceholder(value: unknown): value is string {
  return value === '********' || value === '<redacted>';
}

const SSL_SECRET_FIELDS = ['ca', 'cert', 'key'] as const;
const DRIVER_OPTION_SECRET_FIELDS = [
  'password', 'pass', 'pwd', 'token', 'accessToken', 'secret', 'clientSecret',
  'privateKey', 'connectionString', 'dsn', 'url',
] as const;

/** Merge one extensible nested config object while preserving redacted secrets. */
function mergeNestedConfig(
  baseValue: unknown,
  patchValue: Record<string, unknown>,
  secretFields: readonly string[],
  parentField?: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isObject(baseValue) ? { ...baseValue } : {};
  for (const [key, value] of Object.entries(patchValue)) {
    const tlsSecret = (parentField === 'ssl' || parentField === 'tls') && SSL_SECRET_FIELDS.includes(key as typeof SSL_SECRET_FIELDS[number]);
    if ((secretFields.includes(key) || tlsSecret) && (isSecretPlaceholder(value) || value === '')) continue;
    if (value === undefined) continue;
    const previous = merged[key];
    if (Array.isArray(value) && Array.isArray(previous)) {
      merged[key] = mergeNestedArray(previous, value, secretFields, (parentField === 'ssl' || parentField === 'tls') ? parentField : key);
    } else if (isObject(value) && isObject(previous)) {
      // Recurse for driver-specific option groups (for example
      // `options.auth.password`) while applying the same secret placeholder
      // policy at every level.
      merged[key] = mergeNestedConfig(
        previous,
        value,
        secretFields,
        (parentField === 'ssl' || parentField === 'tls') ? parentField : key,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Merge array entries by index so redacted nested object fields retain their
 * existing credentials during an edit. Arrays are otherwise treated as a
 * replacement, with only corresponding object/array entries merged. */
function mergeNestedArray(
  baseValue: unknown[],
  patchValue: unknown[],
  secretFields: readonly string[],
  parentField?: string,
): unknown[] {
  const merged = [...baseValue];
  for (let index = 0; index < patchValue.length; index += 1) {
    const value = patchValue[index];
    const previous = merged[index];
    if (Array.isArray(value) && Array.isArray(previous)) {
      merged[index] = mergeNestedArray(previous, value, secretFields, parentField);
    } else if (isObject(value) && isObject(previous)) {
      merged[index] = mergeNestedConfig(previous, value, secretFields, parentField);
    } else {
      merged[index] = value;
    }
  }
  // Match ordinary replacement semantics for array length while retaining
  // corresponding old entries that were only redacted in the patch.
  return merged.slice(0, patchValue.length);
}

function protectDatabaseConfig(input: unknown, key: string): Record<string, unknown> {
  const source = isObject(input) ? input : {};
  const config = { ...source } as DatabaseConnectionConfig & Record<string, unknown>;
  // Canonicalize all DSN aliases before encryption so credentials can never
  // remain in plaintext under `url` or `dsn` while `connectionString` is
  // protected. Explicit connectionString takes precedence over aliases.
  const connectionString = usableCredentialPatch(config.connectionString)
    ?? usableCredentialPatch(config.dsn)
    ?? usableCredentialPatch(config.url);
  if (connectionString !== undefined) config.connectionString = connectionString;
  else delete config.connectionString;
  delete config.dsn;
  delete config.url;
  for (const field of ['password', 'connectionString']) {
    const value = config[field] as unknown;
    if (typeof value === 'string' && value && !isEncryptedSecret(value) && !isSecretPlaceholder(value)) {
      (config as Record<string, unknown>)[field] = encryptSecret(value, key);
    }
  }
  if (config.ssl && typeof config.ssl === 'object') {
    const ssl = { ...(config.ssl as Record<string, unknown>) };
    for (const field of ['ca', 'cert', 'key']) {
      if (typeof ssl[field] === 'string' && ssl[field] && !isEncryptedSecret(ssl[field] as string) && !isSecretPlaceholder(ssl[field])) {
        ssl[field] = encryptSecret(ssl[field] as string, key);
      }
    }
    config.ssl = ssl;
  }
  config.options = protectDriverOptions(config.options, key);
  return config;
}

function decryptDatabaseConfig(input: Record<string, unknown>, key: string): DatabaseConnectionConfig {
  const config = { ...input } as unknown as DatabaseConnectionConfig & Record<string, unknown>;
  const connectionString = usableCredentialPatch(config.connectionString)
    ?? usableCredentialPatch(config.dsn)
    ?? usableCredentialPatch(config.url);
  if (connectionString !== undefined) config.connectionString = connectionString;
  else delete config.connectionString;
  delete config.dsn;
  delete config.url;
  for (const field of ['password', 'connectionString']) {
    const value = config[field] as unknown;
    if (typeof value === 'string' && isEncryptedSecret(value)) (config as Record<string, unknown>)[field] = decryptSecret(value, key);
  }
  if (config.ssl && typeof config.ssl === 'object') {
    const ssl = { ...(config.ssl as Record<string, unknown>) };
    for (const field of ['ca', 'cert', 'key']) if (typeof ssl[field] === 'string' && isEncryptedSecret(ssl[field] as string)) ssl[field] = decryptSecret(ssl[field] as string, key);
    config.ssl = ssl;
  }
  config.options = decryptDriverOptions(config.options, key);
  return config;
}

function protectDriverOptions(options: DatabaseConnectionConfig['options'], key: string): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const transformed = transformNestedDriverValue(options, key, 'encrypt');
  return isObject(transformed) ? transformed : {};
}

function decryptDriverOptions(options: DatabaseConnectionConfig['options'], key: string): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const transformed = transformNestedDriverValue(options, key, 'decrypt');
  return isObject(transformed) ? transformed : {};
}

/**
 * Transform credential-shaped fields at every depth of a driver options
 * object. Driver options are extensible and may contain nested auth/TLS
 * groups or arrays, so a shallow copy is not sufficient. A WeakMap avoids
 * repeatedly cloning shared objects; an ancestor set cuts circular references
 * safely (cyclic values cannot be persisted as JSON in any case).
 */
function transformNestedDriverValue(
  value: unknown,
  encryptionKey: string,
  operation: 'encrypt' | 'decrypt',
  seen = new WeakMap<object, unknown>(),
  ancestors = new WeakSet<object>(),
  parentField?: string,
): unknown {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (ancestors.has(value)) return undefined;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    ancestors.add(value);
    for (const item of value) output.push(transformNestedDriverValue(item, encryptionKey, operation, seen, ancestors, parentField));
    ancestors.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  ancestors.add(value);
  const tlsContainer = parentField === 'ssl' || parentField === 'tls';
  for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
    let transformed: unknown;
    const isSecretField = DRIVER_OPTION_SECRET_FIELDS.includes(field as (typeof DRIVER_OPTION_SECRET_FIELDS)[number])
      || (tlsContainer && SSL_SECRET_FIELDS.includes(field as (typeof SSL_SECRET_FIELDS)[number]));
    if (isSecretField && typeof entry === 'string') {
      if (operation === 'encrypt') {
        transformed = entry && !isEncryptedSecret(entry) && !isSecretPlaceholder(entry)
          ? encryptSecret(entry, encryptionKey)
          : entry;
      } else {
        transformed = isEncryptedSecret(entry) ? decryptSecret(entry, encryptionKey) : entry;
      }
    } else {
      transformed = transformNestedDriverValue(entry, encryptionKey, operation, seen, ancestors, field);
    }
    // Define keys explicitly so a user-supplied `__proto__` option remains a
    // data property and cannot mutate the output object's prototype.
    Object.defineProperty(output, field, {
      value: transformed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return output;
}

function splitTableName(value: string): [string | undefined, string] {
  const parts = value.split('.');
  return parts.length === 2 ? [parts[0], parts[1]] : [undefined, value];
}

type FeishuCollectionPage = {
  items?: Array<Record<string, unknown>>;
  tables?: Array<Record<string, unknown>>;
  fields?: Array<Record<string, unknown>>;
  hasMore?: boolean;
  has_more?: boolean;
  pageToken?: string;
  page_token?: string;
};

/**
 * Resolve all tables while supporting both the full FeishuClient and small
 * host/test fakes that only implement the one-page `listTables` method.
 */
async function listAllFeishuTables(client: FeishuClientLike, appToken: string): Promise<Array<Record<string, unknown>>> {
  const extended = client as FeishuClientLike & {
    listAllTables?: (token: string) => Promise<Array<Record<string, unknown>>>;
  };
  if (typeof extended.listAllTables === 'function') {
    const result = await extended.listAllTables(appToken);
    if (Array.isArray(result)) return result.filter(isObject);
  }
  if (typeof client.listTables !== 'function') return [];
  return collectFeishuPages((pageToken) => client.listTables!(appToken, { pageSize: 100, pageToken }), 'tables');
}

/** Resolve all fields with the same compatibility behaviour as tables. */
async function listAllFeishuFields(client: FeishuClientLike, appToken: string, tableId: string): Promise<Array<Record<string, unknown>>> {
  const extended = client as FeishuClientLike & {
    listAllFields?: (token: string, id: string) => Promise<Array<Record<string, unknown>>>;
  };
  if (typeof extended.listAllFields === 'function') {
    const result = await extended.listAllFields(appToken, tableId);
    if (Array.isArray(result)) return result.filter(isObject);
  }
  if (typeof client.listFields !== 'function') return [];
  return collectFeishuPages((pageToken) => client.listFields!(appToken, tableId, { pageSize: 100, pageToken }), 'fields');
}

async function collectFeishuPages(
  fetchPage: (pageToken?: string) => Promise<FeishuCollectionPage | Array<Record<string, unknown>>>,
  collection: 'tables' | 'fields',
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 100_000; page += 1) {
    const raw = await fetchPage(pageToken);
    // A few lightweight fakes return an array directly instead of a page
    // envelope. Treat that as the final page for backwards compatibility.
    if (Array.isArray(raw)) {
      items.push(...raw);
      return items;
    }
    const nested = isObject((raw as Record<string, unknown>).data)
      ? (raw as Record<string, unknown>).data as FeishuCollectionPage
      : undefined;
    const pageItems = raw.items ?? (collection === 'tables' ? raw.tables : raw.fields)
      ?? nested?.items ?? (collection === 'tables' ? nested?.tables : nested?.fields) ?? [];
    if (Array.isArray(pageItems)) items.push(...pageItems.filter(isObject));
    const hasMore = Boolean(raw.hasMore ?? raw.has_more ?? nested?.hasMore ?? nested?.has_more);
    const nextToken = raw.pageToken ?? raw.page_token ?? nested?.pageToken ?? nested?.page_token;
    if (!hasMore || !nextToken) return items;
    if (seenTokens.has(nextToken)) throw new Error('飞书分页返回了重复 page token');
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new Error('飞书分页超过安全上限');
}

function normalizeFeishuTable(table: Record<string, unknown>): Record<string, unknown> {
  // Put canonical aliases last so an API response containing both `id` and
  // `table_id` cannot accidentally expose the stale/non-canonical value.
  return {
    ...table,
    id: firstNonBlank(table.table_id, table.tableId, table.id),
    name: firstNonBlank(table.name, table.table_name, table.tableName) || '',
  };
}

function normalizeFeishuField(field: Record<string, unknown>): Record<string, unknown> {
  const property = isObject(field.property) ? field.property : undefined;
  // As with tables, preserve the full raw object while making the normalized
  // `id`, `name`, `type`, and `property` keys authoritative.
  return {
    ...field,
    id: firstNonBlank(field.field_id, field.fieldId, field.id),
    name: firstNonBlank(field.field_name, field.fieldName, field.name) || '',
    type: field.type ?? field.field_type ?? field.fieldType,
    property,
  };
}

function firstNonBlank(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/** Map internal/upstream failures to stable HTTP statuses for API consumers. */
function statusForError(error: unknown): number {
  if (error instanceof MappingError || error instanceof DatabaseConfigError || error instanceof ReadOnlyQueryError) {
    return 400;
  }
  if (error instanceof DatabaseDependencyError) return 503;
  if (error instanceof DatabaseAdapterError) return error.retryable ? 503 : 502;
  if (error instanceof FeishuApiError) {
    // Preserve actionable upstream client errors (bad credentials, missing
    // table, etc.). Transient/upstream failures are surfaced as gateway or
    // service-unavailable responses rather than masquerading as local 4xx.
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return error.status;
    if (error.retryable) return 503;
    return error.status !== undefined && error.status >= 500 ? 502 : 503;
  }
  return 500;
}

function dryRunClient(): FeishuClientLike {
  return {
    listRecords: async () => ({ items: [], hasMore: false }),
    listAllRecords: async () => [],
    batchCreateRecords: async (_app, _table, records) => [{ records: records.map((record) => ({ fields: record.fields })) }],
    batchUpdateRecords: async (_app, _table, records) => [{ records: records.map((record) => ({ record_id: record.record_id, fields: record.fields })) }],
  };
}
