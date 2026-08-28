# 飞书多维表格 · 数据库同步插件

一个可直接运行的 Node.js/TypeScript 插件服务，用于把 PostgreSQL、MySQL/MariaDB 或 SQLite 的数据同步到飞书多维表格。项目包含配置向导页面、数据库表/字段发现、字段映射与转换、批量新增/更新、后台任务状态和安全凭据存储。

如果你没有编程基础，请先阅读 [《小白入门：把数据库数据同步到飞书多维表格》](BEGINNER_GUIDE.md)。这份教程从 Windows 安装、飞书准备和环境变量开始，带你完成第一次测试同步，再介绍如何继续修改代码。

想系统了解“开发这种项目需要哪些技术、应该按什么顺序学习”，请阅读 [《开发技术栈与学习路线》](TECH_STACK_LEARNING_GUIDE.md)。

## 已实现能力

- 三种数据库适配器：PostgreSQL（`pg`）、MySQL/MariaDB（`mysql2`，支持 `mysql` / `mysql2` / `mariadb` 类型别名及 `mysql://` / `mariadb://` DSN）、SQLite（`better-sqlite3` / `sqlite3` / Node `node:sqlite`）。驱动按需加载，统一提供连接测试、表列表、字段描述、分页读取和只读 SQL。
- 飞书 Open API 客户端：租户 token、目标表字段发现、记录分页读取、最多 500 条/批的新增和更新、429/5xx 指数退避重试。
- 可视化四步向导：数据库连接 → 选择源表 → 配置字段映射 → 预览和运行。
- 映射转换：自动、文本、数字、日期（Unix 毫秒）、布尔、JSON；支持 `upsert` 唯一键或 `append` 仅新增。
- 后台同步任务：任务状态、读取/写入/跳过计数、日志、取消接口；配置和历史记录使用 JSON 文件持久化。
- 数据库密码、连接字符串、TLS 密钥和飞书 App Secret 使用 AES-256-GCM 加密保存，API 响应自动脱敏。

## 快速开始

需要 Node.js 18+ 和 pnpm/npm；第一次使用建议 Node.js 20 LTS 或更高版本。

```powershell
pnpm install
Copy-Item .env.example .env
# 注意：当前 pnpm dev/start 不会自动读取 .env。
# 启动前请在同一个 PowerShell 窗口注入变量：
$env:APP_ENCRYPTION_KEY = '至少32字符的随机长字符串'
$env:ADMIN_TOKEN = '你自己保存的管理员令牌'
pnpm build
pnpm start
```

打开 <http://127.0.0.1:8787/>。开发时可使用 `pnpm dev`。如果启用了 `ADMIN_TOKEN`，首次访问时向导会提示输入令牌，并保存在当前浏览器的本地存储中。Node.js 20.6+ 也可以在构建后使用 `node --env-file=.env dist/src/index.js`；完整说明见 [BEGINNER_GUIDE.md](BEGINNER_GUIDE.md)。

`APP_ENCRYPTION_KEY` 应使用至少 32 个字符的随机长字符串，并通过部署平台的 Secret 注入；不要提交 `.env` 或 `.data/store.json`。生产环境还必须设置 `ADMIN_TOKEN`（至少使用随机长字符串），所有管理 API 请求携带 `Authorization: Bearer <ADMIN_TOKEN>`。生产环境建议放在反向代理后，并限制管理 API 的访问来源。服务默认只允许只读 SQL，源查询必须使用参数化值。

## 飞书侧准备

1. 在飞书开放平台创建企业自建应用，并在应用权限中开启多维表格的应用、数据表、字段和记录读取权限，以及记录新增、更新权限。控制台中的权限名称可能随平台版本调整，以“多维表格 / Bitable”分类下的读写权限为准。
2. 发布应用版本并确保它在当前租户内可用；如果组织策略要求，还需把应用加入目标多维表格的协作者或可访问范围。
3. 从应用“凭证与基础信息”复制 App ID、App Secret。多维表格 App Token 和数据表 ID 可以直接在向导中加载，也可以从多维表格链接/开放平台工具中取得。
4. 生产部署请使用 HTTPS，并只向可信管理员开放本插件页面和 `/api/*` 管理接口。

当前交付形态是可自托管、也可嵌入其它飞书插件页面的同步服务；正式上架飞书应用市场时，还需要按你的应用类型补充市场物料、回调域名、隐私政策和审核配置。

## 配置流程

1. 在“数据库连接”填写类型和连接信息。连接会先执行测试，成功后才保存。
2. 在“选择数据表”加载表列表并选择源表；字段类型来自数据库元数据。
3. 在“字段映射”填写飞书 App ID、App Secret、App Token、数据表 ID，点击“加载目标字段”，然后调整每个源字段的目标名称和转换方式。
4. 在“同步设置”选择 `更新或新增` 或 `仅新增`。使用更新或新增时必须选择源表唯一键；可先勾选“仅预览”确认映射。

## HTTP API（可嵌入其它插件 UI）

成功响应统一为 `{ "data": ... }`，错误响应为 `{ "error": "..." }`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/meta` | 支持的数据库和转换器 |
| POST | `/api/connections` | 测试并保存数据库连接 |
| POST | `/api/connections/test` | 只测试连接，不保存 |
| GET | `/api/connections` | 列出连接（已脱敏） |
| GET | `/api/connections/:id/tables` | 获取源表 |
| GET | `/api/connections/:id/tables/:table/columns` | 获取字段 |
| GET | `/api/connections/:id/preview?table=...&limit=10` | 预览数据 |
| POST | `/api/feishu/tables` | 获取飞书目标表 |
| POST | `/api/feishu/fields` | 获取目标字段 |
| POST | `/api/sync-configs` | 创建/更新同步配置 |
| GET | `/api/sync-configs` | 列出同步配置 |
| POST | `/api/sync-runs` | 创建后台同步任务 |
| GET | `/api/sync-runs/:id` | 查询任务状态 |
| POST | `/api/sync-runs/:id/cancel` | 取消运行中的任务 |

创建同步配置的核心 JSON 示例：

```json
{
  "name": "订单同步",
  "connectionId": "connection-id",
  "source": { "table": "public.orders" },
  "target": {
    "appToken": "bascnxxxxxxxx",
    "tableId": "tblxxxxxxxx",
    "auth": { "appId": "cli_xxx", "appSecret": "secret" }
  },
  "mappings": [
    { "source": "id", "target": "订单号", "transform": "text" },
    { "source": "total_amount", "target": "金额", "transform": "number" },
    { "source": "paid_at", "target": "支付时间", "transform": "date" }
  ],
  "options": {
    "mode": "upsert",
    "keyField": "id",
    "batchSize": 500,
    "pageSize": 500
  }
}
```

如果使用自定义只读查询，请把值放在 `source.params` 中，数据库驱动会按参数顺序绑定（PostgreSQL 使用 `$1`，MySQL/SQLite 使用 `?`）。配置了 `source.query` 后，`source.table` 可以省略，适合 JOIN、聚合或数据库视图；例如：

```json
{
  "source": {
    "query": "SELECT id, total_amount FROM orders WHERE updated_at >= $1",
    "params": ["2025-01-01T00:00:00Z"]
  }
}
```

查询仍会经过只读 SQL 检查；不要把用户输入直接拼接到 SQL 字符串中。

## 目录结构

```text
src/
  db/       多数据库适配器、安全 SQL 和工厂
  sync/     飞书客户端、字段映射、同步引擎
  server.ts HTTP API 与后台任务
  store.ts  JSON 持久化
public/     配置向导 UI
test/       核心单元/集成 smoke tests
```

## 验证

```bash
pnpm build
pnpm test
```

测试覆盖 AES-GCM 凭据、JSON 存储、字段转换、upsert 去重、SQLite 适配器、只读 SQL 防护。大规模生产部署时，建议把 `JsonStore` 替换为事务型数据库，并增加定时调度、增量游标、删除策略和 OAuth 用户授权。
