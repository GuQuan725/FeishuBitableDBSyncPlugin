import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM 编解码。密文格式为 v1.iv.tag.payload（均为 base64url）。 */
export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), payload.toString("base64url")].join(".");
}

export function decryptSecret(value: string, secret: string): string {
  const [version, ivEncoded, tagEncoded, payloadEncoded] = value.split(".");
  if (version !== VERSION || !ivEncoded || !tagEncoded || !payloadEncoded) {
    throw new Error("无效的加密凭据格式");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payloadEncoded, "base64url")), decipher.final()]).toString("utf8");
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}

/** 返回不包含敏感字段的连接配置，适合日志和 API 响应。 */
export function redactSecrets<T extends Record<string, unknown>>(config: T): T {
  // Keep a writable index signature while redacting, then restore the
  // original structural type for callers. TypeScript does not allow writes
  // through a generic `T` index directly (TS2862).
  const clone: Record<string, unknown> = { ...config };
  for (const key of ["password", "token", "appSecret", "tenantAccessToken", "accessToken", "clientSecret", "connectionString", "dsn", "url"]) {
    if (key in clone) clone[key] = "********";
  }
  return clone as T;
}
