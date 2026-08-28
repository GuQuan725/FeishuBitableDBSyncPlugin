import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAppServer, type AppServer, type AppServerOptions } from '../src/server.js';
import { JsonStore } from '../src/store.js';
import { createDatabaseAdapter } from '../src/db/index.js';
import { decryptSecret } from '../src/security.js';
import type { FeishuClientLike } from '../src/sync/index.js';

const ENCRYPTION_KEY = 'integration-test-encryption-key-32-chars';
const ADMIN_TOKEN = 'integration-admin-token';

type JsonObject = Record<string, unknown>;

interface HttpResult<T = unknown> {
  response: Response;
  body: JsonObject;
  data: T;
}

async function request<T = unknown>(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<HttpResult<T>> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json() as JsonObject;
  return { response, body, data: (body.data ?? body) as T };
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

async function createSqliteFixture(): Promise<{ dir: string; dbPath: string; storePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-http-'));
  const dbPath = join(dir, 'source.sqlite');
  const storePath = join(dir, 'store.json');
  const adapter = createDatabaseAdapter({ type: 'sqlite', filename: dbPath, readOnly: false });
  try {
    await adapter.connect();
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    await adapter.execute('INSERT INTO users (name, active) VALUES (?, ?)', ['Ada', 1]);
    await adapter.execute('INSERT INTO users (name, active) VALUES (?, ?)', ['Grace', 0]);
  } finally {
    await adapter.close();
  }
  return { dir, dbPath, storePath };
}

async function startApp(
  storePath: string,
  options: Pick<AppServerOptions, 'adminToken' | 'feishuClientFactory'> = {},
): Promise<{ app: AppServer; baseUrl: string; store: JsonStore }> {
  const store = new JsonStore(storePath);
  const app = createAppServer({
    host: '127.0.0.1',
    port: 0,
    store,
    encryptionKey: ENCRYPTION_KEY,
    publicDir: join(process.cwd(), 'public'),
    ...options,
  });
  await app.listen();
  const address = app.address();
  return { app, baseUrl: `http://${address.host}:${address.port}`, store };
}

test('HTTP health endpoint and ADMIN_TOKEN authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-http-health-'));
  const { app, baseUrl } = await startApp(join(dir, 'store.json'), { adminToken: ADMIN_TOKEN });
  try {
    const unauthorized = await request(baseUrl, '/api/health');
    assert.equal(unauthorized.response.status, 401);
    assert.match(String(unauthorized.body.error), /未授权|令牌/);

    const wrongToken = await request(baseUrl, '/api/health', {}, 'wrong-token');
    assert.equal(wrongToken.response.status, 401);

    const health = await request<{ ok: boolean; service: string }>(baseUrl, '/api/health', {}, ADMIN_TOKEN);
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.service, 'feishu-bitable-db-sync');

    const meta = await request<{ databaseTypes: JsonObject[] }>(baseUrl, '/api/meta', {}, ADMIN_TOKEN);
    assert.equal(meta.response.status, 200);
    const mysql = meta.data.databaseTypes.find((entry) => entry.value === 'mysql');
    assert.ok(mysql);
    assert.ok(Array.isArray(mysql.aliases) && mysql.aliases.includes('mariadb'));
    const postgres = meta.data.databaseTypes.find((entry) => entry.value === 'postgres');
    const sqlite = meta.data.databaseTypes.find((entry) => entry.value === 'sqlite');
    assert.ok(postgres && Array.isArray(postgres.aliases) && postgres.aliases.includes('postgresql'));
    assert.ok(sqlite && Array.isArray(sqlite.aliases) && sqlite.aliases.includes('sqlite3'));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite connection APIs discover tables, columns, preview rows, and protect saved credentials', async () => {
  const fixture = await createSqliteFixture();
  const { app, baseUrl, store } = await startApp(fixture.storePath, { adminToken: ADMIN_TOKEN });
  try {
    const created = await request<JsonObject>(baseUrl, '/api/connections', jsonBody({
      name: '本地源库',
      type: 'sqlite',
      config: {
        type: 'sqlite',
        filename: fixture.dbPath,
        password: 'do-not-store-this-password',
        readOnly: true,
        ssl: { key: 'nested-tls-key', rejectUnauthorized: true },
        options: {
          password: 'nested-driver-password',
          auth: { password: 'deep-driver-password' },
          replicas: [{ token: 'deep-driver-token' }],
          label: 'remove-me',
          keep: 'unchanged',
        },
      },
    }), ADMIN_TOKEN);
    assert.equal(created.response.status, 201);
    const connection = created.data;
    assert.equal(connection.type, 'sqlite');
    assert.ok(typeof connection.id === 'string' && connection.id.length > 0);
    const connectionId = String(connection.id);
    const publicConfig = connection.config as JsonObject;
    assert.equal(publicConfig.password, '********');
    assert.equal((publicConfig.ssl as JsonObject).key, '<redacted>');
    assert.equal((publicConfig.options as JsonObject).password, '<redacted>');
    assert.equal(((publicConfig.options as JsonObject).auth as JsonObject).password, '<redacted>');
    assert.equal((((publicConfig.options as JsonObject).replicas as JsonObject[])[0]).token, '<redacted>');

    const edited = await request<JsonObject>(baseUrl, '/api/connections', jsonBody({
      id: connectionId,
      name: '本地源库（已编辑）',
      type: 'sqlite',
      config: {
        type: 'sqlite',
        // Exercise both public placeholder spellings. They must preserve the
        // existing plaintext rather than encrypting the placeholder itself.
        ssl: { key: '<redacted>', rejectUnauthorized: false },
        options: {
          password: '********',
          auth: { password: '********' },
          replicas: [{ token: '<redacted>' }],
          label: '',
          added: 'new-value',
        },
      },
    }), ADMIN_TOKEN);
    assert.equal(edited.response.status, 200);
    assert.equal(edited.data.name, '本地源库（已编辑）');

    const listed = await request<JsonObject[]>(baseUrl, '/api/connections', {}, ADMIN_TOKEN);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].id, connectionId);

    const tables = await request<JsonObject[]>(baseUrl, `/api/connections/${encodeURIComponent(connectionId)}/tables`, {}, ADMIN_TOKEN);
    assert.equal(tables.response.status, 200);
    assert.ok(tables.data.some((table) => table.name === 'users'));

    const columns = await request<JsonObject[]>(baseUrl, `/api/connections/${encodeURIComponent(connectionId)}/tables/users/columns`, {}, ADMIN_TOKEN);
    assert.equal(columns.response.status, 200);
    assert.deepEqual(columns.data.map((column) => column.name), ['id', 'name', 'active']);
    assert.equal(columns.data.find((column) => column.name === 'id')?.isPrimaryKey, true);

    const preview = await request<JsonObject[]>(baseUrl, `/api/connections/${encodeURIComponent(connectionId)}/preview?table=users&limit=1`, {}, ADMIN_TOKEN);
    assert.equal(preview.response.status, 200);
    assert.equal(preview.data.length, 1);
    assert.deepEqual(preview.data[0], { id: 1, name: 'Ada', active: 1 });

    const rawStore = await readFile(fixture.storePath, 'utf8');
    assert.doesNotMatch(rawStore, /do-not-store-this-password/);
    assert.doesNotMatch(rawStore, /deep-driver-password|deep-driver-token/);
    const stored = await store.getConnection(connectionId);
    assert.ok(stored);
    assert.notEqual(stored.config.password, 'do-not-store-this-password');
    assert.match(String(stored.config.password), /^v1\./);
    const storedSsl = stored.config.ssl as JsonObject;
    const storedOptions = stored.config.options as JsonObject;
    assert.equal(decryptSecret(String(storedSsl.key), ENCRYPTION_KEY), 'nested-tls-key');
    assert.equal(decryptSecret(String(storedOptions.password), ENCRYPTION_KEY), 'nested-driver-password');
    assert.equal(decryptSecret(String((storedOptions.auth as JsonObject).password), ENCRYPTION_KEY), 'deep-driver-password');
    assert.equal(decryptSecret(String(((storedOptions.replicas as JsonObject[])[0]).token), ENCRYPTION_KEY), 'deep-driver-token');
    assert.equal(storedSsl.rejectUnauthorized, false);
    assert.equal(storedOptions.label, '');
    assert.equal(storedOptions.keep, 'unchanged');
    assert.equal(storedOptions.added, 'new-value');
  } finally {
    await app.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('sync config validates key fields and dry-run reaches succeeded', async () => {
  const fixture = await createSqliteFixture();
  const { app, baseUrl, store } = await startApp(fixture.storePath, { adminToken: ADMIN_TOKEN });
  try {
    const createdConnection = await request<JsonObject>(baseUrl, '/api/connections', jsonBody({
      name: '同步源库',
      type: 'sqlite',
      config: { type: 'sqlite', filename: fixture.dbPath, readOnly: true },
    }), ADMIN_TOKEN);
    assert.equal(createdConnection.response.status, 201);
    const connectionId = String(createdConnection.data.id);

    const invalidKey = await request(baseUrl, '/api/sync-configs', jsonBody({
      name: '错误配置',
      connectionId,
      source: { table: 'users' },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'missing', dryRun: true },
    }), ADMIN_TOKEN);
    assert.equal(invalidKey.response.status, 400);
    assert.match(String(invalidKey.body.error), /唯一键/);

    const invalidDryRun = await request(baseUrl, '/api/sync-configs', jsonBody({
      name: '错误干跑值',
      connectionId,
      source: { query: 'SELECT id FROM users' },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'id', dryRun: 'false' },
      enabled: true,
    }), ADMIN_TOKEN);
    assert.equal(invalidDryRun.response.status, 400);
    assert.match(String(invalidDryRun.body.error), /dryRun.*布尔/);

    const invalidEnabled = await request(baseUrl, '/api/sync-configs', jsonBody({
      name: '错误启用值',
      connectionId,
      source: { query: 'SELECT id FROM users' },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'id', dryRun: true },
      enabled: 'false',
    }), ADMIN_TOKEN);
    assert.equal(invalidEnabled.response.status, 400);
    assert.match(String(invalidEnabled.body.error), /enabled.*布尔/);

    const explicitFalse = await request<JsonObject>(baseUrl, '/api/sync-configs', jsonBody({
      name: '显式关闭配置',
      connectionId,
      source: { query: 'SELECT id FROM users' },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'id', dryRun: false },
      enabled: false,
    }), ADMIN_TOKEN);
    assert.equal(explicitFalse.response.status, 201);
    assert.equal((explicitFalse.data.options as JsonObject).dryRun, false);
    assert.equal(explicitFalse.data.enabled, false);

    const missingSource = await request(baseUrl, '/api/sync-configs', jsonBody({
      name: '缺少源',
      connectionId,
      source: {},
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'id', dryRun: true },
    }), ADMIN_TOKEN);
    assert.equal(missingSource.response.status, 400);
    assert.match(String(missingSource.body.error), /源数据表|自定义查询/);

    const invalidTable = await request(baseUrl, '/api/sync-configs', jsonBody({
      name: '非法表名',
      connectionId,
      source: { table: 'users; DROP TABLE users' },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'upsert', keyField: 'id', dryRun: true },
    }), ADMIN_TOKEN);
    assert.equal(invalidTable.response.status, 400);
    assert.match(String(invalidTable.body.error), /标识符|identifier|表名/i);

    const createdConfig = await request<JsonObject>(baseUrl, '/api/sync-configs', jsonBody({
      name: '干跑配置',
      connectionId,
      source: { query: 'SELECT id, name FROM users WHERE id > ?', params: [0] },
      target: { appToken: 'app-token', tableId: 'table-id', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [
        { source: 'id', target: 'ID', transform: 'number' },
        { source: 'name', target: 'Name', transform: 'text' },
      ],
      options: { mode: 'upsert', keyField: 'id', dryRun: true, batchSize: 10, pageSize: 10 },
      enabled: true,
    }), ADMIN_TOKEN);
    assert.equal(createdConfig.response.status, 201);
    const configId = String(createdConfig.data.id);
    const publicSource = createdConfig.data.source as JsonObject;
    assert.equal(publicSource.table, undefined);
    assert.equal(publicSource.query, 'SELECT id, name FROM users WHERE id > ?');
    const publicAuth = ((createdConfig.data.target as JsonObject).auth as JsonObject);
    assert.equal(publicAuth.appSecret, '********');

    const runCreated = await request<JsonObject>(baseUrl, '/api/sync-runs', jsonBody({ configId }), ADMIN_TOKEN);
    assert.equal(runCreated.response.status, 202);
    const runId = String(runCreated.data.id);
    const completed = await waitFor(
      async () => (await request<JsonObject>(baseUrl, `/api/sync-runs/${encodeURIComponent(runId)}`, {}, ADMIN_TOKEN)).data,
      (run) => run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled',
    );
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.readRows, 2);
    assert.equal(completed.writtenRows, 2);
    assert.equal(completed.error, undefined);

    const storedConfig = await store.getSyncConfig(configId);
    assert.ok(storedConfig);
    assert.notEqual(storedConfig.target.auth.appSecret, 'secret');
    assert.match(storedConfig.target.auth.appSecret, /^v1\./);
  } finally {
    await app.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('invalid database type is rejected with HTTP 400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-http-invalid-'));
  const { app, baseUrl } = await startApp(join(dir, 'store.json'), { adminToken: ADMIN_TOKEN });
  try {
    const result = await request(baseUrl, '/api/connections', jsonBody({
      name: '不支持的连接',
      type: 'oracle',
      config: { type: 'oracle', host: 'localhost' },
    }), ADMIN_TOKEN);
    assert.equal(result.response.status, 400);
    assert.match(String(result.body.error), /Unsupported|不支持/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feishu table and field discovery supports paged fake clients and canonical ids/names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-http-feishu-'));
  const calls: Array<{ kind: string; pageToken?: string }> = [];
  const fakeClient: FeishuClientLike = {
    listRecords: async () => ({ items: [], hasMore: false }),
    listTables: async (_appToken, options = {}) => {
      calls.push({ kind: 'tables', pageToken: options.pageToken });
      return options.pageToken
        ? { items: [{ table_id: 'tbl-2', table_name: '订单' }], hasMore: false }
        : { items: [{ table_id: 'tbl-1', table_name: '用户' }], hasMore: true, pageToken: 'tables-next' };
    },
    listFields: async (_appToken, _tableId, options = {}) => {
      calls.push({ kind: 'fields', pageToken: options.pageToken });
      return options.pageToken
        ? { items: [{ field_id: 'fld-2', field_name: '姓名', type: 1 }], hasMore: false }
        : { items: [{ field_id: 'fld-1', field_name: '编号', type: 2, property: { formatter: '0' } }], hasMore: true, pageToken: 'fields-next' };
    },
    batchCreateRecords: async () => [],
    batchUpdateRecords: async () => [],
  };
  const { app, baseUrl } = await startApp(join(dir, 'store.json'), {
    adminToken: ADMIN_TOKEN,
    feishuClientFactory: async ({ appId, appSecret }) => {
      assert.equal(appId, 'fake-app');
      assert.equal(appSecret, 'fake-secret');
      return fakeClient;
    },
  });
  try {
    const tables = await request<JsonObject[]>(baseUrl, '/api/feishu/tables', jsonBody({
      appToken: 'fake-token', appId: 'fake-app', appSecret: 'fake-secret',
    }), ADMIN_TOKEN);
    assert.equal(tables.response.status, 200);
    assert.deepEqual(tables.data.map((table) => ({ id: table.id, name: table.name })), [
      { id: 'tbl-1', name: '用户' },
      { id: 'tbl-2', name: '订单' },
    ]);

    const fields = await request<JsonObject[]>(baseUrl, '/api/feishu/fields', jsonBody({
      appToken: 'fake-token', tableId: 'tbl-1', appId: 'fake-app', appSecret: 'fake-secret',
    }), ADMIN_TOKEN);
    assert.equal(fields.response.status, 200);
    assert.deepEqual(fields.data.map((field) => ({ id: field.id, name: field.name })), [
      { id: 'fld-1', name: '编号' },
      { id: 'fld-2', name: '姓名' },
    ]);
    assert.equal((fields.data[0].property as JsonObject).formatter, '0');
    assert.deepEqual(calls, [
      { kind: 'tables', pageToken: undefined },
      { kind: 'tables', pageToken: 'tables-next' },
      { kind: 'fields', pageToken: undefined },
      { kind: 'fields', pageToken: 'fields-next' },
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
