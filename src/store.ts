import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type StoredDatabaseType = "postgres" | "mysql" | "sqlite";
/** JSON-safe values accepted as persisted custom-query parameters. */
export type StoredQueryParam = string | number | boolean | null;

export interface StoredConnection {
  id: string;
  name: string;
  type: StoredDatabaseType;
  /** 凭据字段由 server 以 AES-GCM 加密后写入。 */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMapping {
  source: string;
  target: string;
  transform?: "text" | "number" | "date" | "boolean" | "json" | "auto";
  defaultValue?: unknown;
}

export interface SyncConfigRecord {
  id: string;
  name: string;
  connectionId: string;
  /**
   * A source may be a discovered table, a custom read-only query, or both.
   * `table` is optional because query-only configurations are useful for
   * joins, filters, and database views that are not exposed as a table.
   */
  source: { table?: string; schema?: string; query?: string; params?: StoredQueryParam[] };
  target: { appToken: string; tableId: string; auth: { appId: string; appSecret: string } };
  mappings: SyncMapping[];
  options: {
    mode: "append" | "upsert";
    keyField?: string;
    batchSize: number;
    pageSize: number;
    dryRun?: boolean;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SyncRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface SyncRunRecord {
  id: string;
  configId: string;
  status: SyncRunStatus;
  startedAt?: string;
  finishedAt?: string;
  readRows: number;
  writtenRows: number;
  skippedRows: number;
  error?: string;
  logs: string[];
}

interface PersistedState {
  connections: StoredConnection[];
  syncConfigs: SyncConfigRecord[];
  syncRuns: SyncRunRecord[];
}

const EMPTY_STATE: PersistedState = { connections: [], syncConfigs: [], syncRuns: [] };

/** 小型 JSON 持久化存储，适合单实例插件；生产部署可替换为 SQLite/Redis 实现。 */
export class JsonStore {
  private state: PersistedState = structuredClone(EMPTY_STATE);
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        connections: Array.isArray(parsed.connections) ? parsed.connections : [],
        syncConfigs: Array.isArray(parsed.syncConfigs) ? parsed.syncConfigs : [],
        syncRuns: Array.isArray(parsed.syncRuns) ? parsed.syncRuns : []
      };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code !== "ENOENT") throw error;
      this.state = structuredClone(EMPTY_STATE);
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Include a random suffix so two JsonStore instances targeting the same
    // file cannot overwrite each other's temporary file before the atomic
    // rename. A per-instance write queue still serializes normal writes.
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }

  private async save(): Promise<void> {
    // Keep a rejected write from poisoning the queue forever.  `operation`
    // remains the promise returned to this caller (so its original error is
    // still observable), while the barrier stored in `writeChain` always
    // resolves and lets later writes make progress after a transient disk
    // failure.
    const operation = this.writeChain.then(() => this.persist());
    this.writeChain = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async listConnections(): Promise<StoredConnection[]> {
    await this.load();
    return structuredClone(this.state.connections);
  }

  async getConnection(id: string): Promise<StoredConnection | undefined> {
    await this.load();
    const value = this.state.connections.find((item) => item.id === id);
    return value ? structuredClone(value) : undefined;
  }

  async upsertConnection(input: Omit<StoredConnection, "id" | "createdAt" | "updatedAt"> & Partial<Pick<StoredConnection, "id" | "createdAt">>): Promise<StoredConnection> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.state.connections.find((item) => item.id === input.id) : undefined;
    const value: StoredConnection = {
      id: input.id || randomUUID(),
      name: input.name,
      type: input.type,
      config: structuredClone(input.config),
      createdAt: input.createdAt || existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, value);
    else this.state.connections.push(value);
    await this.save();
    return structuredClone(value);
  }

  async deleteConnection(id: string): Promise<boolean> {
    await this.load();
    const before = this.state.connections.length;
    this.state.connections = this.state.connections.filter((item) => item.id !== id);
    if (before === this.state.connections.length) return false;
    this.state.syncConfigs = this.state.syncConfigs.filter((item) => item.connectionId !== id);
    await this.save();
    return true;
  }

  async listSyncConfigs(): Promise<SyncConfigRecord[]> {
    await this.load();
    return structuredClone(this.state.syncConfigs);
  }

  async getSyncConfig(id: string): Promise<SyncConfigRecord | undefined> {
    await this.load();
    const value = this.state.syncConfigs.find((item) => item.id === id);
    return value ? structuredClone(value) : undefined;
  }

  async upsertSyncConfig(input: Omit<SyncConfigRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<SyncConfigRecord, "id" | "createdAt">>): Promise<SyncConfigRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.state.syncConfigs.find((item) => item.id === input.id) : undefined;
    const value: SyncConfigRecord = {
      id: input.id || randomUUID(),
      name: input.name,
      connectionId: input.connectionId,
      source: structuredClone(input.source),
      target: structuredClone(input.target),
      mappings: structuredClone(input.mappings),
      options: {
        // Keep persistence defaults aligned with SyncConfig/BitableSyncService:
        // upsert is the safer idempotent mode when an API caller omits the
        // optional mode field.
        mode: input.options?.mode || "upsert",
        keyField: input.options?.keyField,
        batchSize: Math.min(Math.max(input.options?.batchSize || 500, 1), 500),
        pageSize: Math.min(Math.max(input.options?.pageSize || 500, 1), 5000),
        dryRun: Boolean(input.options?.dryRun)
      },
      enabled: input.enabled !== false,
      createdAt: input.createdAt || existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, value);
    else this.state.syncConfigs.push(value);
    await this.save();
    return structuredClone(value);
  }

  async createSyncRun(configId: string): Promise<SyncRunRecord> {
    await this.load();
    const run: SyncRunRecord = { id: randomUUID(), configId, status: "queued", readRows: 0, writtenRows: 0, skippedRows: 0, logs: [] };
    this.state.syncRuns.push(run);
    await this.save();
    return structuredClone(run);
  }

  async getSyncRun(id: string): Promise<SyncRunRecord | undefined> {
    await this.load();
    const value = this.state.syncRuns.find((item) => item.id === id);
    return value ? structuredClone(value) : undefined;
  }

  async listSyncRuns(configId?: string): Promise<SyncRunRecord[]> {
    await this.load();
    const values = configId ? this.state.syncRuns.filter((item) => item.configId === configId) : this.state.syncRuns;
    return structuredClone(values).reverse();
  }

  async updateSyncRun(id: string, patch: Partial<SyncRunRecord>): Promise<SyncRunRecord | undefined> {
    await this.load();
    const run = this.state.syncRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, structuredClone(patch));
    await this.save();
    return structuredClone(run);
  }

  /**
   * Update a run only while it is in one of the expected states.  The state
   * check and mutation happen synchronously after `load()`, so competing
   * in-process requests cannot observe an intermediate transition.  This is
   * used to linearize cancellation against the worker's success/failure
   * transition and prevent a late worker completion from resurrecting a
   * cancelled run.
   */
  async updateSyncRunIfStatus(
    id: string,
    expected: SyncRunStatus | readonly SyncRunStatus[],
    patch: Partial<SyncRunRecord>,
  ): Promise<SyncRunRecord | undefined> {
    await this.load();
    const run = this.state.syncRuns.find((item) => item.id === id);
    if (!run) return undefined;
    const expectedStatuses = Array.isArray(expected) ? expected : [expected];
    if (!expectedStatuses.includes(run.status)) return undefined;
    Object.assign(run, structuredClone(patch));
    await this.save();
    return structuredClone(run);
  }
}
