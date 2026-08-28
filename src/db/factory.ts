import { MySQLAdapter } from './mysql.js';
import { PostgresAdapter } from './postgres.js';
import { SQLiteAdapter } from './sqlite.js';
import { normalizeConnectionConfig } from './security.js';
import {
  AdapterDependencies,
  DatabaseAdapter,
  DatabaseConnectionConfig,
  NormalizedDatabaseType,
} from './types.js';

/** Create an adapter without loading any optional database dependency yet. */
export function createDatabaseAdapter(
  input: DatabaseConnectionConfig,
  dependencies: AdapterDependencies = {},
): DatabaseAdapter {
  const config = normalizeConnectionConfig(input);
  return createNormalizedAdapter(config.type, config, dependencies);
}

/** Alias kept short for route handlers and sync jobs. */
export const createAdapter = createDatabaseAdapter;
export const createDbAdapter = createDatabaseAdapter;
export const getDatabaseAdapter = createDatabaseAdapter;

export async function connectDatabase(
  input: DatabaseConnectionConfig,
  dependencies: AdapterDependencies = {},
): Promise<DatabaseAdapter> {
  const adapter = createDatabaseAdapter(input, dependencies);
  await adapter.connect();
  return adapter;
}

function createNormalizedAdapter(
  type: NormalizedDatabaseType,
  config: ReturnType<typeof normalizeConnectionConfig>,
  dependencies: AdapterDependencies,
): DatabaseAdapter {
  switch (type) {
    case 'postgres':
      return new PostgresAdapter(config, dependencies);
    case 'mysql':
      return new MySQLAdapter(config, dependencies);
    case 'sqlite':
      return new SQLiteAdapter(config, dependencies);
    default:
      // TypeScript exhaustiveness guard; normalizeConnectionConfig catches
      // unknown values before this branch.
      throw new Error(`Unsupported database type: ${String(type)}`);
  }
}
