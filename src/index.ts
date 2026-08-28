import { loadConfig } from './config.js';
import { JsonStore } from './store.js';
import { createAppServer } from './server.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export * from './config.js';
export * from './security.js';
export * from './store.js';
export * from './server.js';
export * from './db/index.js';
export * from './sync/index.js';

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain = entryPath === modulePath || entryPath.replace(/\.ts$/, '.js') === modulePath;

if (isMain) {
  const config = loadConfig();
  const app = createAppServer({
    host: config.host,
    port: config.port,
    store: new JsonStore(config.dataFile),
    encryptionKey: config.encryptionKey,
    feishuBaseUrl: config.feishuBaseUrl,
    adminToken: config.adminToken,
  });
  app.listen().then(() => {
    const address = app.address();
    console.log(`Feishu Bitable DB Sync listening on http://${address.host}:${address.port}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
