# Database adapters

`src/db` exposes one small interface for PostgreSQL, MySQL/MariaDB, and
SQLite. Database drivers are optional, so an installation only needs the
driver(s) it actually uses:

```sh
pnpm add pg                 # PostgreSQL
pnpm add mysql2             # MySQL/MariaDB
pnpm add better-sqlite3     # SQLite (fast synchronous driver)
```

Use `postgres`/`postgresql`/`pg`, `mysql`/`mysql2`/`mariadb`, or
`sqlite`/`sqlite3` as the connection type. MySQL-compatible DSNs may use
either `mysql://` or `mariadb://` and are normalized to the `mysql` adapter.

Node 22's built-in `node:sqlite` and the callback-based `sqlite3` package are
also detected as fallbacks. The adapter does not import any of these packages
at compile time; this keeps the plugin deployable with a single database
driver and allows tests to inject a fake driver through `dependencies.driver`.

```ts
import { createDatabaseAdapter } from './db/index.js';

const db = createDatabaseAdapter({
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'orders',
  user: 'sync_reader',
  password: process.env.DB_PASSWORD,
  // Connections are read-only by default.
});

try {
  await db.connect();
  const tables = await db.listTables();
  for await (const rows of db.iterateRows('orders', { pageSize: 500 })) {
    // Map each page to Feishu records and write a bounded batch.
  }
} finally {
  await db.close();
}
```

`query` and `readTable` reject write statements when `readOnly` is enabled,
reject multiple statements, and parameterise generated filters. Dynamic table
and column names are validated and quoted. Use `execute` with
`readOnly: false` only for an explicitly trusted maintenance connection.
