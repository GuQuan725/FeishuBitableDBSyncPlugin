import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseConfigError,
  ReadOnlyQueryError,
  assertSafeSql,
  buildWhereClause,
  createDatabaseAdapter,
  normalizeConnectionConfig,
  redactConnectionConfig,
  quoteIdentifierPath,
} from '../src/db/index.js';

test('normalizes aliases and protects credentials in generated config', async () => {
  const adapter = createDatabaseAdapter({ type: 'postgresql', host: 'localhost', password: 'secret' }, {
    driver: {
      query(_sql: string, _params: unknown[], callback: (error: unknown, result: unknown) => void) {
        callback(null, { rows: [{ ok: 1 }], rowCount: 1 });
      },
      end(callback: (error?: unknown) => void) { callback(); },
    },
  });
  assert.equal(adapter.type, 'postgres');
  assert.equal(adapter.config.password, 'secret');
  await adapter.connect();
  await adapter.close();
});

test('redacts credential-shaped nested driver options', () => {
  const redacted = redactConnectionConfig({
    type: 'mysql',
    host: 'db.internal',
    options: {
      password: 'pw',
      auth: { password: 'nested-pw' },
      replicas: [{ token: 'nested-token' }],
      clientSecret: 'client-secret',
      connectionString: 'mysql://user:pw@db.internal/app',
      dsn: 'mysql://user:pw@db.internal/app',
      url: 'mysql://user:pw@db.internal/app',
      token: 'token',
      ssl: { key: 'nested-tls-key', ca: 'nested-ca', label: 'keep' },
      poolSize: 4,
    },
  });
  const options = redacted.options as Record<string, unknown>;
  for (const key of ['password', 'clientSecret', 'connectionString', 'dsn', 'url', 'token']) {
    assert.equal(options[key], '<redacted>', key);
  }
  assert.equal((options.auth as Record<string, unknown>).password, '<redacted>');
  assert.equal(((options.replicas as Array<Record<string, unknown>>)[0]).token, '<redacted>');
  assert.equal((options.ssl as Record<string, unknown>).key, '<redacted>');
  assert.equal((options.ssl as Record<string, unknown>).ca, '<redacted>');
  assert.equal((options.ssl as Record<string, unknown>).label, 'keep');
  assert.equal(options.poolSize, 4);
});

test('accepts MariaDB aliases and mariadb:// connection strings', () => {
  const config = normalizeConnectionConfig({
    type: 'mariadb',
    connectionString: 'mariadb://readonly:secret@db.internal/app',
  });
  assert.equal(config.type, 'mysql');
  assert.equal(config.connectionString, 'mariadb://readonly:secret@db.internal/app');
  const adapter = createDatabaseAdapter({
    type: 'mariadb',
    connectionString: 'mariadb://readonly:secret@db.internal/app',
  }, {
    driver: {
      query(_sql: string, _params: unknown[], callback: (error: unknown, result: unknown) => void) {
        callback(null, { rows: [{ ok: 1 }], rowCount: 1 });
      },
      end(callback: (error?: unknown) => void) { callback(); },
    },
  });
  assert.equal(adapter.type, 'mysql');
});

test('rejects writes and multiple statements on read-only connections', () => {
  assert.throws(() => assertSafeSql('DELETE FROM users'), ReadOnlyQueryError);
  assert.throws(() => assertSafeSql('SELECT 1; DROP TABLE users'), ReadOnlyQueryError);
  assert.doesNotThrow(() => assertSafeSql("SELECT * FROM users WHERE name = 'DROP TABLE users'"));
  assert.throws(() => assertSafeSql('PRAGMA journal_mode(WAL)'), ReadOnlyQueryError);
  assert.doesNotThrow(() => assertSafeSql('PRAGMA table_info("users")'));
});

test('quotes identifiers and parameterizes filters', () => {
  assert.equal(quoteIdentifierPath('public.orders', 'postgres'), '"public"."orders"');
  assert.equal(quoteIdentifierPath('orders', 'mysql'), '`orders`');
  assert.throws(() => quoteIdentifierPath('orders; DROP TABLE x', 'mysql'), DatabaseConfigError);
  const where = buildWhereClause([
    { column: 'status', operator: '=', value: 'open' },
    { column: 'id', operator: 'IN', value: [1, 2] },
  ], 'postgres');
  assert.equal(where.sql, ' WHERE "status" = $1 AND "id" IN ($2, $3)');
  assert.deepEqual(where.params, ['open', 1, 2]);
});

test('mysql callback driver is normalized to the common result shape', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const driver = {
    query(sql: string, params: unknown[], callback: (error: unknown, rows: unknown[], fields: unknown[]) => void) {
      calls.push({ sql, params });
      if (/^SELECT 1/i.test(sql)) return callback(null, [{ ok: 1 }], [{ name: 'ok' }]);
      return callback(null, [{ id: 7 }], [{ name: 'id' }]);
    },
    end(callback: (error?: unknown) => void) { callback(); },
  };
  const adapter = createDatabaseAdapter({ type: 'mysql', host: 'localhost' }, { driver });
  const result = await adapter.query<{ id: number }>('SELECT id FROM users WHERE id = ?', [7]);
  assert.deepEqual(result.rows, [{ id: 7 }]);
  assert.equal(result.fields?.[0]?.name, 'id');
  assert.equal(calls.length, 2); // eager health probe + requested query
  await adapter.close();
});

test('mysql promise driver receives exactly sql and params without a callback', async () => {
  const calls: Array<{ sql: string; params: unknown[]; argumentCount: number }> = [];
  const driver = {
    query(sql: string, params: unknown[]) {
      calls.push({ sql, params, argumentCount: arguments.length });
      assert.equal(arguments.length, 2, 'promise clients must not receive a callback');
      return Promise.resolve(
        /^SELECT 1/i.test(sql)
          ? [[{ ok: 1 }], [{ name: 'ok' }]]
          : [[{ id: 7 }], [{ name: 'id' }]],
      );
    },
    end() { return Promise.resolve(); },
  };
  const adapter = createDatabaseAdapter({ type: 'mysql', host: 'localhost' }, { driver });
  const result = await adapter.query<{ id: number }>('SELECT id FROM users WHERE id = ?', [7]);
  assert.deepEqual(result.rows, [{ id: 7 }]);
  assert.equal(result.fields?.[0]?.name, 'id');
  assert.deepEqual(calls.map((call) => call.argumentCount), [2, 2]);
  await adapter.close();
});

test('mysql short callback driver is supported for queries without parameters', async () => {
  const calls: Array<{ sql: string; argumentCount: number }> = [];
  const driver = {
    query(sql: string, callback: (error: unknown, rows: unknown[], fields: unknown[]) => void) {
      calls.push({ sql, argumentCount: arguments.length });
      assert.equal(arguments.length, 2);
      callback(null, [{ ok: 1 }], [{ name: 'ok' }]);
    },
    end(callback: (error?: unknown) => void) { callback(); },
  };
  const adapter = createDatabaseAdapter({ type: 'mysql', host: 'localhost' }, { driver });
  const result = await adapter.query('SELECT 2');
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.deepEqual(calls.map((call) => call.argumentCount), [2, 2]);
  await adapter.close();
});

test('mysql rest callback fake remains compatible without duplicate invocation', async () => {
  const calls: unknown[][] = [];
  const driver = {
    query(...args: unknown[]) {
      calls.push(args);
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('callback is not a function');
      callback(null, [{ ok: 1 }], [{ name: 'ok' }]);
    },
    end(callback: (error?: unknown) => void) { callback(); },
  };
  const adapter = createDatabaseAdapter({ type: 'mysql', host: 'localhost' }, { driver });
  const result = await adapter.query('SELECT 2');
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.deepEqual(calls.map((args) => args.length), [3, 3]);
  await adapter.close();
});

test('mysql rest promise fake falls back to two-argument invocation once', async () => {
  const calls: unknown[][] = [];
  const driver = {
    query(...args: unknown[]) {
      calls.push(args);
      if (args.length !== 2) throw new Error('strict arity');
      return Promise.resolve([[{ ok: 1 }], [{ name: 'ok' }]]);
    },
    end() { return Promise.resolve(); },
  };
  const adapter = createDatabaseAdapter({ type: 'mysql', host: 'localhost' }, { driver });
  const result = await adapter.query('SELECT 2');
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  // Signature inspection sends each logical query exactly once with the
  // promise signature; no callback probe is attempted.
  assert.deepEqual(calls.map((args) => args.length), [2, 2]);
  await adapter.close();
});

test('postgres callback driver receives positional parameters and field metadata', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query(sql: string, params: unknown[], callback: (error: unknown, result: unknown) => void) {
      calls.push({ sql, params });
      callback(null, {
        rows: [{ id: 3 }],
        rowCount: 1,
        fields: [{ name: 'id', dataTypeID: 23 }],
      });
    },
  };
  const adapter = createDatabaseAdapter({ type: 'pg', host: 'localhost' }, { driver: pool });
  const result = await adapter.query<{ id: number }>('SELECT id FROM users WHERE id = $1', [3]);
  assert.deepEqual(result.rows, [{ id: 3 }]);
  assert.equal(result.fields?.[0]?.dataType, '23');
  assert.equal(calls.length, 2);
  await adapter.close();
});

test('sqlite3 callback driver preserves run metadata bound on statement context', async () => {
  const handle = {
    all(sql: string, _params: unknown[], callback: (error: unknown, rows: unknown[]) => void) {
      callback(null, /^SELECT 1/i.test(sql) ? [{ ok: 1 }] : []);
    },
    run(_sql: string, _params: unknown[], callback: (this: { changes: number; lastID: number }, error: unknown) => void) {
      callback.call({ changes: 1, lastID: 42 }, null);
    },
    close(callback: (error?: unknown) => void) { callback(); },
  };
  const adapter = createDatabaseAdapter(
    { type: 'sqlite3', filename: ':memory:', readOnly: false },
    { driver: handle },
  );
  try {
    await adapter.connect();
    const result = await adapter.execute('INSERT INTO users (name) VALUES (?)', ['Ada']);
    assert.equal(result.affectedRows, 1);
    assert.equal(result.rowCount, 1);
    assert.equal(result.insertId, 42);
  } finally {
    await adapter.close();
  }
});
