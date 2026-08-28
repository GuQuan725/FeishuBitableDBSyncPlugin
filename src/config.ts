import process from "node:process";

export interface AppConfig {
  host: string;
  port: number;
  encryptionKey: string;
  dataFile: string;
  feishuBaseUrl: string;
  adminToken?: string;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const encryptionKey = env.APP_ENCRYPTION_KEY?.trim() || "local-development-only-key-change-me";
  if (env.NODE_ENV === "production" && !env.APP_ENCRYPTION_KEY?.trim()) {
    throw new Error("生产环境必须设置 APP_ENCRYPTION_KEY");
  }
  if (encryptionKey.length < 32) {
    throw new Error("APP_ENCRYPTION_KEY 至少需要 32 个字符");
  }
  const adminToken = env.ADMIN_TOKEN?.trim() || undefined;
  if (env.NODE_ENV === "production" && !adminToken) {
    throw new Error("生产环境必须设置 ADMIN_TOKEN，以保护管理 API");
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: numberFromEnv(env.PORT, 8787),
    encryptionKey,
    dataFile: env.DATA_FILE?.trim() || ".data/store.json",
    feishuBaseUrl: (env.FEISHU_BASE_URL?.trim() || "https://open.feishu.cn").replace(/\/$/, ""),
    adminToken,
  };
}
