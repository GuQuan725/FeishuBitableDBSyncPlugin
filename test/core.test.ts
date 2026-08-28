import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encryptSecret, decryptSecret } from '../src/security.js';
import { JsonStore } from '../src/store.js';
import { createAppServer } from '../src/server.js';
import { mapRow } from '../src/sync/field-mapping.js';
import { BitableSyncService, FeishuClient, type FeishuClientLike } from '../src/sync/index.js';
import { createDatabaseAdapter, assertSafeSql } from '../src/db/index.js';

test('AES-GCM credentials round-trip and do not expose plaintext', () => {
  const secret = 'a'.repeat(32);
  const encrypted = encryptSecret('db-password-123', secret);
  assert.notEqual(encrypted, 'db-password-123');
  assert.equal(decryptSecret(encrypted, secret), 'db-password-123');
  assert.throws(() => decryptSecret(encrypted, 'wrong-secret'), /unable|authenticate|Unsupported|bad/i);
});

test('JSON store persists connections and masks generated ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-sync-'));
  const file = join(dir, 'store.json');
  try {
    const store = new JsonStore(file);
    const item = await store.upsertConnection({ name: 'demo', type: 'sqlite', config: { filename: ':memory:' } });
    assert.ok(item.id);
    const reloaded = new JsonStore(file);
    assert.equal((await reloaded.getConnection(item.id))?.name, 'demo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON store defaults sync configs to idempotent upsert mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-sync-default-mode-'));
  try {
    const store = new JsonStore(join(dir, 'store.json'));
    const config = await store.upsertSyncConfig({
      name: 'default-mode',
      connectionId: 'connection',
      source: { table: 'users' },
      target: { appToken: 'app', tableId: 'table', auth: { appId: 'id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID' }],
      options: { mode: undefined as never, batchSize: 500, pageSize: 100 },
      enabled: true,
    });
    assert.equal(config.options.mode, 'upsert');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('conditional sync-run transitions preserve a cancelled terminal state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-sync-cas-'));
  const file = join(dir, 'store.json');
  try {
    const store = new JsonStore(file);
    const run = await store.createSyncRun('config');
    assert.equal((await store.updateSyncRunIfStatus(run.id, 'queued', { status: 'running' }))?.status, 'running');
    assert.equal((await store.updateSyncRunIfStatus(run.id, 'running', { status: 'cancelled' }))?.status, 'cancelled');
    assert.equal(await store.updateSyncRunIfStatus(run.id, 'running', { status: 'succeeded' }), undefined);
    assert.equal((await store.getSyncRun(run.id))?.status, 'cancelled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelling an active sync cannot be overwritten by a late successful batch', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-sync-cancel-'));
  const store = new JsonStore(join(dir, 'store.json'));
  const encryptionKey = 'c'.repeat(32);
  let enterBatch!: () => void;
  let releaseBatch!: () => void;
  const batchEntered = new Promise<void>((resolve) => { enterBatch = resolve; });
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const client: FeishuClientLike = {
    listRecords: async () => ({ items: [], hasMore: false }),
    listAllRecords: async () => [],
    batchCreateRecords: async (_app, _table, records) => {
      enterBatch();
      await batchGate; // deliberately ignore AbortSignal to exercise the worker's post-call guard
      return [{ records: records.map((record) => ({ fields: record.fields })) }];
    },
    batchUpdateRecords: async () => [],
  };
  const app = createAppServer({
    host: '127.0.0.1',
    port: 0,
    store,
    encryptionKey,
    publicDir: join(process.cwd(), 'public'),
    feishuClientFactory: async () => client,
  });
  try {
    const connection = await store.upsertConnection({
      name: 'memory',
      type: 'sqlite',
      config: { type: 'sqlite', filename: ':memory:', readOnly: false },
    });
    const config = await store.upsertSyncConfig({
      name: 'cancel-race',
      connectionId: connection.id,
      source: { table: 'unused', query: 'SELECT 1 AS id' },
      target: { appToken: 'app', tableId: 'table', auth: { appId: 'app-id', appSecret: 'secret' } },
      mappings: [{ source: 'id', target: 'ID', transform: 'number' }],
      options: { mode: 'append', batchSize: 500, pageSize: 100, dryRun: false },
      enabled: true,
    });
    await app.listen();
    const address = app.address();
    const baseUrl = `http://${address.host}:${address.port}`;
    const createResponse = await fetch(`${baseUrl}/api/sync-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: config.id }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json() as { data: { id: string } };
    await batchEntered;

    const cancelResponse = await fetch(`${baseUrl}/api/sync-runs/${created.data.id}/cancel`, { method: 'POST' });
    assert.equal(cancelResponse.status, 200);
    releaseBatch();
    // Let the ignored-abort fake return so the worker attempts its terminal
    // transition; the conditional store update must keep `cancelled` intact.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await store.getSyncRun(created.data.id))?.status, 'cancelled');
  } finally {
    releaseBatch?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON store write queue recovers after a failed persist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitable-sync-write-'));
  const file = join(dir, 'store.json');
  try {
    const store = new JsonStore(file);
    await store.load();
    const target = store as unknown as {
      persist: () => Promise<void>;
    };
    const originalPersist = target.persist.bind(store);
    let attempts = 0;
    target.persist = async () => {
      if (attempts++ === 0) throw new Error('temporary disk failure');
      return originalPersist();
    };
    await assert.rejects(
      store.upsertConnection({ name: 'first', type: 'sqlite', config: { filename: ':memory:' } }),
      /temporary disk failure/,
    );
    const second = await store.upsertConnection({ name: 'second', type: 'sqlite', config: { filename: ':memory:' } });
    const reloaded = new JsonStore(file);
    assert.equal((await reloaded.getConnection(second.id))?.name, 'second');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('field mapping applies JSON-safe transforms', async () => {
  const result = await mapRow(
    { id: '42', amount: '12.5', happened: '2025-01-02T03:04:05Z', active: 'yes', payload: '{"a":1}' },
    [
      { source: 'id', target: 'ID', transform: 'text' },
      { source: 'amount', target: 'Amount', transform: 'number' },
      { source: 'happened', target: 'Happened', transform: 'date' },
      { source: 'active', target: 'Active', transform: 'boolean' },
      { source: 'payload', target: 'Payload', transform: 'json' },
    ],
  );
  assert.deepEqual(result.fields.ID, '42');
  assert.equal(result.fields.Amount, 12.5);
  assert.equal(typeof result.fields.Happened, 'number');
  assert.equal(result.fields.Active, true);
  assert.deepEqual(result.fields.Payload, { a: 1 });
});

test('sync service upserts in Feishu-sized batches and de-duplicates keys', async () => {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const client: FeishuClientLike = {
    listRecords: async () => ({ items: [], hasMore: false }),
    listAllRecords: async () => [{ record_id: 'rec-existing', fields: { ID: '2' } }],
    batchCreateRecords: async (_app, _table, records) => { created.push(...records); return [{ records: records.map((r) => ({ fields: r.fields })) }]; },
    batchUpdateRecords: async (_app, _table, records) => { updated.push(...records); return [{ records: records.map((r) => ({ record_id: r.record_id, fields: r.fields })) }]; },
  };
  const result = await new BitableSyncService(client).sync(
    [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '1', name: 'A latest' }],
    { appToken: 'app', tableId: 'tbl', mappings: [{ source: 'id', target: 'ID' }, { source: 'name', target: 'Name' }], uniqueKey: 'id', mode: 'upsert' },
  );
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);
  assert.equal((created[0].fields as Record<string, unknown>).Name, 'A latest');
});

test('Feishu client retries transient responses, follows pages, and batches writes', async () => {
  let calls = 0;
  const requests: Array<{ url: string; body?: string }> = [];
  const fetchMock = async (input: string | URL, init?: { body?: string }) => {
    calls += 1;
    requests.push({ url: String(input), body: init?.body });
    if (calls === 1) {
      return { ok: false, status: 503, statusText: 'busy', headers: { get: () => null }, json: async () => ({ code: 1254290, msg: 'rate limit' }) };
    }
    const url = new URL(String(input));
    if (url.pathname.endsWith('/records') && init?.body === undefined) {
      const token = url.searchParams.get('page_token');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ code: 0, data: token ? { items: [{ record_id: 'r2', fields: { ID: 2 } }], has_more: false } : { items: [{ record_id: 'r1', fields: { ID: 1 } }], has_more: true, page_token: 'next' } }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { records: [] } }) };
  };
  const client = new FeishuClient({ baseUrl: 'https://mock.local', fetch: fetchMock, maxRetries: 2, initialDelayMs: 0, jitter: 0, sleep: async () => undefined, accessToken: 'token' });
  const records = await client.listAllRecords('app', 'table', { pageSize: 2 });
  assert.deepEqual(records.map((record) => record.record_id), ['r1', 'r2']);
  await client.listTables('app', { pageSize: 500 });
  await client.listFields('app', 'table', { pageSize: 500 });
  await client.batchCreateRecords('app', 'table', [{ fields: { ID: 1 } }, { fields: { ID: 2 } }], { batchSize: 1 });
  assert.equal(requests.filter((request) => request.body).length, 2);
  assert.ok(requests.every((request) => request.url.startsWith('https://mock.local/')));
  const collectionRequests = requests.filter((request) => {
    const pathname = new URL(request.url).pathname;
    return pathname.endsWith('/tables') || pathname.endsWith('/fields');
  });
  assert.equal(collectionRequests.length, 2);
  assert.ok(collectionRequests.every((request) => new URL(request.url).searchParams.get('page_size') === '100'));
});

test('sqlite adapter works with the optional better-sqlite3 driver', async () => {
  const adapter = createDatabaseAdapter({ type: 'sqlite', filename: ':memory:', readOnly: false });
  try {
    await adapter.connect();
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.execute('INSERT INTO users (name) VALUES (?)', ['Ada']);
    const tables = await adapter.listTables();
    assert.ok(tables.some((table) => table.name === 'users'));
    const columns = await adapter.describeTable('users');
    assert.ok(columns.some((column) => column.name === 'name'));
    const rows = await adapter.readTable<{ id: number; name: string }>('users');
    assert.deepEqual(rows.rows[0], { id: 1, name: 'Ada' });
  } finally {
    await adapter.close();
  }
});

test('read-only SQL guard rejects mutations and multiple statements', () => {
  assert.doesNotThrow(() => assertSafeSql('SELECT 1'));
  assert.throws(() => assertSafeSql('DROP TABLE users'), /read-only|Only read-only/i);
  assert.throws(() => assertSafeSql('SELECT 1; SELECT 2'), /Multiple SQL/i);
});
