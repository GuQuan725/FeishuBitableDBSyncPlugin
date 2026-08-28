# 小白入门：把数据库数据同步到飞书多维表格

> 本文写给第一次接触代码、Node.js、数据库和飞书开放平台的人。你不需要先学会编程：先照着“本机运行”做出一次测试同步，再按后面的“继续开发”章节逐步理解代码。

如果你想先了解完整技术栈和学习顺序，可以阅读 [《开发技术栈与学习路线》](TECH_STACK_LEARNING_GUIDE.md)。

## 1. 先用一句话理解项目

本项目是一个可以自己运行的同步服务：

`数据库（源数据） → 插件读取并转换 → 飞书多维表格（目标数据）`

它默认用只读方式连接数据库，读取表中的记录，把字段转换成飞书能接受的格式，然后批量写入目标多维表格。它不会把飞书数据写回数据库。

第一次使用时，请先准备测试数据库和测试多维表格。不要一开始就对生产数据运行“仅新增”。

## 2. 项目能做什么，暂时不能做什么

### 已经能做的事

- 连接 PostgreSQL、MySQL/MariaDB 或 SQLite。
- 自动发现数据库中的表和字段，预览源数据。
- 选择要同步的源表。
- 把源字段映射到飞书目标字段。
- 把值转换成文本、数字、日期、布尔值或 JSON。
- 选择“更新或新增（upsert）”或“仅新增（append）”。
- 通过唯一键识别已有记录，减少重复写入。
- 分批写入飞书，查看后台任务状态、读取数、写入数、跳过数和日志。
- 加密保存数据库密码、连接字符串和飞书 App Secret；接口返回会隐藏敏感值。
- 在本机运行，也可以用 Docker 部署。

### 当前的边界

- 网页向导是手动启动同步，项目没有内置定时调度器。
- 默认是全量读取，没有增量游标、删除同步或双向同步。
- 没有 OAuth 多用户授权流程，凭据由本服务管理员配置。
- 配置和历史记录保存在一个 JSON 文件中，适合单实例或小规模自托管；多台服务器同时写入前需要替换存储实现。
- 自定义 SQL 是高级 API 功能，当前网页向导没有 SQL 输入框。
- 这不是已经上架飞书应用市场的一键安装插件，而是一个可自托管的同步服务加网页向导。若要正式上架，还要准备域名、HTTPS、回调、隐私政策、OAuth 和市场审核材料。

## 3. 先认识几个词

| 词 | 用人话解释 | 本项目里的例子 |
| --- | --- | --- |
| 数据库 | 保存数据的系统 | 订单库、用户库 |
| 表 | 数据库里的一张表格 | `orders` |
| 字段 | 表格的一列 | `id`、`amount` |
| 记录 | 表格的一行 | 一笔订单或一个用户 |
| 源 | 数据从哪里来 | PostgreSQL 的 `orders` 表 |
| 目标 | 数据写到哪里 | 飞书多维表格中的某张数据表 |
| 字段映射 | 把源列接到目标列 | `amount` → `金额` |
| 唯一键 | 能唯一识别一行的值 | 订单号、用户 ID |
| upsert | 有则更新、无则新增 | 重复运行通常不会重复 |
| append | 每次都新增 | 适合一次性导入或日志追加 |
| Node.js | 让 JavaScript 在电脑上运行的程序 | 启动本服务 |
| pnpm / npm | 安装依赖和运行脚本的工具 | `pnpm install` |
| PowerShell | Windows 的命令窗口 | 输入安装和启动命令 |
| 环境变量 | 启动程序时提供的配置 | 端口、加密密钥 |
| App ID / App Secret | 飞书应用的“身份证 / 密码” | 企业自建应用凭证 |
| App Token | 一个多维表格容器的编号 | 通常以 `bascn` 开头 |
| 数据表 ID | 容器里某张子表的编号 | 通常以 `tbl` 开头 |

## 4. 开始前准备

你需要：

- 一台能访问数据库和飞书开放接口的电脑或服务器。
- 一个数据库只读账号；SQLite 则准备一个本地 `.db` 文件。
- 一个飞书企业自建应用。
- App ID、App Secret、目标多维表格的 App Token、数据表 ID。
- 目标应用拥有读取表/字段/记录，以及创建和更新记录的权限。

第一次学习推荐用 Windows 本机运行和 SQLite。这样不需要先安装 PostgreSQL 或 MySQL 服务器，也最容易定位问题。

## 5. Windows 安装 Node.js、pnpm 和 VS Code

### 5.1 安装 Node.js

1. 打开 [Node.js 官网](https://nodejs.org/)，下载 Windows Installer。
2. 建议安装 Node.js 20 LTS 或 22 LTS。项目最低要求是 Node.js 18，但较新的 pnpm 通常更适合 Node.js 20 或更高版本。
3. 安装时保留默认选项，并确认勾选 **Add to PATH**。
4. 安装完成后关闭旧的 PowerShell，重新打开一个窗口。
5. 执行：

   ```powershell
   node --version
   npm --version
   ```

   看到类似 `v20.x.x`、`v22.x.x` 和 npm 版本号，就说明安装成功。

如果提示“node 不是内部或外部命令”，请重新打开终端；仍不行时重装 Node.js 并确认 Add to PATH。

### 5.2 安装 VS Code（推荐但不是必须）

VS Code 是编辑代码的工具。打开 [Visual Studio Code 官网](https://code.visualstudio.com/) 下载 Windows 版本并安装。安装时可以勾选“添加到 PATH”和“用 Code 打开文件夹”。

如果你只想使用网页向导，暂时不装 VS Code 也可以。

### 5.3 安装 pnpm

在 PowerShell 执行：

```powershell
npm install --global pnpm
pnpm --version
```

如果你的 Node.js 已经带有 Corepack，也可以使用：

```powershell
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

如果 Corepack 或公司网络报错，回到上面的 `npm install --global pnpm` 方法即可。

如果 PowerShell 报“禁止运行 pnpm.ps1”，把命令中的 `pnpm` 改成 `pnpm.cmd`，例如：

```powershell
pnpm.cmd --version
pnpm.cmd install
```

也可以完全使用 npm，不要在同一次安装中混用两种包管理器：

| pnpm | npm |
| --- | --- |
| `pnpm install` | `npm install` |
| `pnpm build` | `npm run build` |
| `pnpm start` | `npm start` |
| `pnpm dev` | `npm run dev` |
| `pnpm test` | `npm test` |

## 6. 获取项目并安装依赖

### 6.1 打开项目根目录

你可以下载 ZIP 后解压，也可以用 Git 克隆。假设项目位于：

```text
D:\projects\MultiDTableDBLinkPlugin
```

在该目录空白处右键“在终端中打开”，或执行：

```powershell
cd D:\projects\MultiDTableDBLinkPlugin
Get-ChildItem package.json
```

如果能看到 `package.json`，说明进入了正确的项目根目录。不要在 `src` 或 `public` 子目录中执行安装命令。

### 6.2 安装项目依赖

```powershell
pnpm install
```

第一次可能需要几分钟。项目把数据库驱动列为可选依赖，通常这一步会同时安装：

- PostgreSQL：`pg`
- MySQL/MariaDB：`mysql2`
- SQLite：`better-sqlite3`

如果运行时明确提示缺少某个驱动，再按类型补装：

```powershell
pnpm add pg                 # PostgreSQL
pnpm add mysql2             # MySQL / MariaDB
pnpm add better-sqlite3     # SQLite
```

Windows 上如果 `better-sqlite3` 没有预编译包，错误可能提到 Visual C++ Build Tools。可以按提示安装构建工具，或改用 `sqlite3`；Node.js 22 还可能使用内置 `node:sqlite` 备用方式。

## 7. 配置环境变量

### 7.1 复制模板

在项目根目录执行：

```powershell
Copy-Item .env.example .env
notepad .env
```

保存时确认文件名是 `.env`，不是 `.env.txt`。模板中各项的作用：

| 变量 | 作用 | 建议 |
| --- | --- | --- |
| `APP_ENCRYPTION_KEY` | 加密数据库密码和飞书 Secret | 至少 32 个字符，长期保持不变 |
| `ADMIN_TOKEN` | 保护管理 API | 本地可设一个令牌；生产必须设置 |
| `HOST` | 监听地址 | 本机用 `127.0.0.1` |
| `PORT` | 网页端口 | 默认 `8787` |
| `DATA_FILE` | JSON 存储文件 | 默认 `.data/store.json` |
| `FEISHU_BASE_URL` | 飞书 API 地址 | 默认不需要改 |
| `NODE_ENV` | 运行环境标记 | 生产可设为 `production` |

### 7.2 本机启动的 .env 注意事项

当前版本的 `pnpm dev` 和 `pnpm start` 直接读取 PowerShell 进程里的环境变量，不会自动读取根目录的 `.env` 文件。复制模板是为了保存配置清单，但只编辑文件还不够。

在**同一个** PowerShell 窗口里，启动前先执行：

```powershell
$env:APP_ENCRYPTION_KEY = '请替换成至少32字符的随机长字符串'
$env:ADMIN_TOKEN = '请替换成你自己记得的管理员令牌'
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
```

可以用两个 GUID 生成足够长的随机值：

```powershell
$env:APP_ENCRYPTION_KEY = ([guid]::NewGuid().ToString() + [guid]::NewGuid().ToString())
$env:ADMIN_TOKEN = ([guid]::NewGuid().ToString() + [guid]::NewGuid().ToString())
$env:APP_ENCRYPTION_KEY
$env:ADMIN_TOKEN
```

把输出保存到密码管理器。`APP_ENCRYPTION_KEY` 一旦用于保存凭据，就不要随便更换；更换或丢失会导致旧的 `.data/store.json` 无法解密。每次打开新的 PowerShell 窗口，这些变量都需要重新设置。

Node.js 20.6 或更高版本在构建后可以直接加载 `.env`：

```powershell
pnpm build
node --env-file=.env dist/src/index.js
```

Node.js 18 不支持 `--env-file`；`pnpm dev` 也建议使用前面的 PowerShell 变量写法。

## 8. 启动服务

### 8.1 开发模式

适合边改代码边观察：

```powershell
pnpm dev
```

终端出现类似文字才算成功：

```text
Feishu Bitable DB Sync listening on http://127.0.0.1:8787
```

### 8.2 正式构建并启动

```powershell
pnpm build
pnpm start
```

`pnpm start` 前必须先 `pnpm build`，否则 `dist/src/index.js` 可能不存在。

### 8.3 打开网页

在运行服务的同一台电脑打开：

- <http://127.0.0.1:8787/>
- <http://127.0.0.1:8787/api/health>

网页右上角应显示“服务正常”。终端必须保持打开；停止服务时回到终端按 `Ctrl+C`。

端口被占用时，先设置新端口再启动：

```powershell
$env:PORT = '8788'
pnpm dev
```

然后打开 <http://127.0.0.1:8788/>。默认 `HOST=127.0.0.1` 只允许本机访问；只有容器或明确的局域网场景才考虑 `HOST=0.0.0.0`，并同时配置防火墙和 HTTPS/反向代理。

## 9. 准备飞书应用

飞书控制台的名称可能随版本变化，按“多维表格 / Bitable”分类寻找权限。

1. 打开飞书开放平台，创建一个**企业自建应用**。
2. 在权限管理中开启多维表格应用、数据表、字段和记录的读取权限，以及记录新增、更新权限。
3. 发布一个应用版本，并确认应用在当前租户可用。
4. 确认应用可以访问目标多维表格。常见做法是把应用加入目标表格的协作者或可访问范围。
5. 从“凭证与基础信息”复制 App ID 和 App Secret。
6. 打开目标多维表格，取得 App Token 和数据表 ID。它们也可以从多维表格链接或开放平台工具找到：App Token 通常以 `bascn` 开头，数据表 ID 通常以 `tbl` 开头。

把 App Secret 当作密码处理：不要放进 SQL、代码截图、Git 提交或聊天群。生产部署请使用 HTTPS。

## 10. 第一次完整同步：网页四步向导

第一次最好复制一张测试目标表，并先做 dry-run（页面中的“仅预览”）。

### 第一步：数据库连接

在左侧点击“数据库连接”。

- 连接名称：例如“测试订单库”。
- 数据库类型：选择 PostgreSQL、MySQL/MariaDB 或 SQLite。
- SQLite：填写文件路径，例如 `D:\data\orders.db`。`:memory:` 只适合短暂测试，后台同步不要依赖它。
- PostgreSQL/MySQL：填写主机、端口、数据库名、只读用户名和密码。
- 连接字符串：可选。填写后会覆盖主机、端口等单独字段。

点击“测试并保存连接”。成功后下面会出现“已保存的连接”，并自动进入第二步。

### 第二步：选择源表

点击“刷新数据表”，再点击要同步的表卡片。只读账号无权访问的表不会出现。

选择成功后，页面会显示字段，并根据数据库类型自动建议转换方式。看到字段卡片和“已选择”提示，说明发现成功。

### 第三步：配置字段映射

1. 填写飞书 App ID、App Secret、App Token。
2. 点击“加载目标表”，选择要写入的目标数据表。
3. 点击“加载目标字段”。
4. 逐行检查“源字段 → 目标字段 → 转换方式”。

源字段名和飞书字段名可以不同，但目标字段必须写成飞书中的准确名称。示例：

| 源字段 | 目标字段 | 转换 | 说明 |
| --- | --- | --- | --- |
| `id` | 订单号 | `text` | 稳定唯一键 |
| `customer_name` | 客户 | `text` | 普通文字 |
| `total_amount` | 金额 | `number` | 可转成数字 |
| `paid_at` | 支付时间 | `date` | Unix 毫秒时间戳 |
| `paid` | 已支付 | `boolean` | 1/0、是/否等 |

转换方式：

- `auto`：尽量保留原值。
- `text`：转成文字。
- `number`：转成数字，无法转换会报错。
- `date`：转成飞书接受的 Unix 毫秒时间戳；检查时区。
- `boolean`：转成 true 或 false。
- `json`：把 JSON 字符串解析成对象或数组。

同一个目标字段不要映射两次。第一次先映射需要的字段，不必把源表每一列都导入。

### 第四步：同步设置、预览和运行

- 更新或新增（upsert）：推荐。选择稳定且不为空的唯一键，通常是 `id`；该字段必须已经映射。
- 仅新增（append）：每次运行都创建新记录，重复运行可能产生重复数据。
- 批量大小：最多 500；第一次保留默认值即可。
- 每页读取：最多 5000；第一次保留默认值即可。
- 仅预览：先勾选，再点击“读取 10 行”，检查日期、数字、布尔值和字段名称。

确认预览正确后，取消“仅预览”，点击“开始同步”。任务在后台运行，页面可以关闭；稍后在页面底部“最近同步任务”查看状态。

成功时应看到“已完成”，并看到读取和写入行数。失败时先记下任务错误文字，再检查第 15 节的排错表。

> 预览验证的是源数据和映射格式。第一次真实写入仍建议使用测试表。不要连续盲目点击“开始同步”，以免自己创建多个任务。

## 11. 没有数据库时，用 SQLite 练习

SQLite 是一个文件，不需要单独启动数据库服务器，最适合第一次学习。可以安装免费的 [DB Browser for SQLite](https://sqlitebrowser.org/)，新建 `D:\data\orders.db`，打开“执行 SQL”并运行：

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL,
  total_amount DECIMAL(12, 2),
  paid_at TEXT,
  paid INTEGER NOT NULL DEFAULT 0
);

INSERT INTO orders (id, customer_name, total_amount, paid_at, paid) VALUES
  (1001, '张三', 99.90, '2025-01-02T10:00:00Z', 1),
  (1002, '李四', 128.50, '2025-01-03T11:30:00Z', 0);
```

在向导第一步选择 SQLite，文件名填写 `D:\data\orders.db`，再按第 10 节操作。

如果使用 PostgreSQL 或 MySQL/MariaDB，只需填写主机、端口、数据库名、用户名、密码；先用数据库客户端确认同一组信息能连接，并给账号最小的只读权限。

## 12. 高级功能：通过 HTTP API 使用自定义查询

网页向导当前只能选择已发现的源表；**自定义 SQL 不是网页按钮**，需要手动调用 API 或自己编写客户端。普通使用者可以跳过本节。

成功响应通常是 `{ "data": ... }`，错误响应是顶层 `{ "error": "..." }`。如果设置了 `ADMIN_TOKEN`，所有 `/api/*` 请求都要带：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

PowerShell 中可以这样检查服务和列出连接（把令牌放在当前窗口的环境变量里）：

```powershell
$headers = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/connections' -Headers $headers
```

不设置 `ADMIN_TOKEN` 时可以省略 `$headers`。如果返回 401，先检查令牌是否和启动服务的窗口里设置的值完全一致。

### 12.1 自定义查询规则

- 只能执行一条只读语句，例如 `SELECT` 或只读的 `WITH`。
- 不允许 `INSERT`、`UPDATE`、`DELETE`、多条语句或会改变状态的 SQL。
- 值放入 `source.params`，不要把用户输入直接拼进 SQL。
- PostgreSQL 使用 `$1`、`$2`；MySQL/SQLite 使用 `?`。
- 参数只能是字符串、数字、布尔值或 `null`。
- query-only 执行会一次性读取查询结果；大查询要注意内存，必要时先改成源表分页同步。

`source` 片段示例（不是完整请求，仍需要 `connectionId`、`target`、`mappings` 和 `options`）：

```json
{
  "source": {
    "query": "SELECT id, total_amount FROM orders WHERE updated_at >= $1",
    "params": ["2025-01-01T00:00:00Z"]
  }
}
```

完整配置的核心结构：

```json
{
  "name": "订单同步",
  "connectionId": "connection-id",
  "source": {
    "query": "SELECT id, total_amount FROM orders WHERE updated_at >= $1",
    "params": ["2025-01-01T00:00:00Z"]
  },
  "target": {
    "appToken": "bascnxxxxxxxx",
    "tableId": "tblxxxxxxxx",
    "auth": {
      "appId": "cli_xxx",
      "appSecret": "请放真实 Secret，不要提交到代码仓库"
    }
  },
  "mappings": [
    { "source": "id", "target": "订单号", "transform": "text" },
    { "source": "total_amount", "target": "金额", "transform": "number" }
  ],
  "options": {
    "mode": "upsert",
    "keyField": "id",
    "batchSize": 500,
    "pageSize": 500,
    "dryRun": true
  },
  "enabled": true
}
```

`upsert` 必须提供 `keyField`，且必须匹配已映射的源字段或目标字段；`append` 可以不设置唯一键。创建任务的接口会立即返回 `202` 和 `queued` 状态，随后轮询任务接口直到 `succeeded`、`failed` 或 `cancelled`。

## 13. API 速查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/meta` | 查看数据库和转换器 |
| GET | `/api/connections` | 列出脱敏连接 |
| POST | `/api/connections` | 测试并保存/更新连接 |
| POST | `/api/connections/test` | 只测试连接 |
| DELETE | `/api/connections/:id` | 删除连接，并删除其同步配置 |
| GET | `/api/connections/:id/tables` | 获取源表 |
| GET | `/api/connections/:id/tables/:table/columns` | 获取字段 |
| GET | `/api/connections/:id/preview?table=...&limit=10` | 预览 1～100 行 |
| POST | `/api/feishu/tables` | 获取目标数据表 |
| POST | `/api/feishu/fields` | 获取目标字段 |
| GET | `/api/sync-configs` | 列出同步配置 |
| POST | `/api/sync-configs` | 创建/更新同步配置 |
| GET | `/api/sync-configs/:id` | 查看单个配置 |
| DELETE | `/api/sync-configs/:id` | 停用配置，保留历史 |
| GET | `/api/sync-runs` | 查看任务历史 |
| POST | `/api/sync-runs` | 创建后台任务，返回 202 |
| GET | `/api/sync-runs/:id` | 查询进度和日志 |
| POST | `/api/sync-runs/:id/cancel` | 取消任务 |

删除同步配置实际是停用（`enabled=false`），不是物理删除。当前没有内置定时调度；需要 Windows 任务计划程序、Linux cron、CI 或队列服务定时调用 `POST /api/sync-runs`。

## 14. Docker 运行（可选）

Docker 路线不需要本机 Node.js 和 pnpm，但需要 Docker Desktop。

1. 安装并启动 Docker Desktop。
2. 在项目根目录执行：

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   把 `APP_ENCRYPTION_KEY` 和 `ADMIN_TOKEN` 换成真实随机长字符串。Docker Compose 会读取项目根目录的 `.env` 来替换变量。
3. 构建并启动：

   ```powershell
   docker compose -f docker-compose.example.yml up -d --build
   ```

4. 打开 <http://127.0.0.1:8787/>；查看日志：

   ```powershell
   docker compose -f docker-compose.example.yml logs -f
   ```

5. 停止：

   ```powershell
   docker compose -f docker-compose.example.yml down
   ```

数据会保存在项目目录的 `data` 卷中。若数据库运行在宿主机，容器里的 `127.0.0.1` 指向容器自己；Windows Docker Desktop 通常应尝试 `host.docker.internal`，并确认数据库允许连接。

## 15. 常见问题：看到什么，怎么处理

| 看到的现象 | 常见原因 | 处理办法 |
| --- | --- | --- |
| “服务不可用” | 服务没启动、端口不对 | 看终端是否有 listening；确认地址和 `PORT` 一致 |
| `node 不是内部或外部命令` | Node.js 未安装或 PATH 未刷新 | 重开 PowerShell，检查 Node.js 安装 |
| `pnpm is not recognized` | pnpm 未安装或旧终端未刷新 | 执行 `npm install --global pnpm`；重开终端，或用 `pnpm.cmd` |
| `.env` 改了但不生效 | 本机脚本不会自动读取 `.env` | 在同一窗口设置 `$env:...`，或用 Node 20.6+ 的 `--env-file` |
| `APP_ENCRYPTION_KEY 至少需要 32 个字符` | 密钥太短 | 换成至少 32 字符并重启 |
| 生产环境必须设置密钥/令牌 | `NODE_ENV=production` 缺少变量 | 设置稳定的 `APP_ENCRYPTION_KEY` 和 `ADMIN_TOKEN` |
| 浏览器 401 或弹出令牌框 | ADMIN_TOKEN 与浏览器保存的令牌不一致 | 输入正确令牌；输错时清除站点本地存储或用无痕窗口 |
| `EADDRINUSE` | 8787 已被其他程序占用 | 改 `PORT=8788`，再用新地址访问 |
| 缺少 `pg`、`mysql2` 或 SQLite 驱动 | 可选依赖未安装 | 执行对应 `pnpm add ...`，然后重启 |
| 数据库连接拒绝/超时 | 主机、端口、防火墙、白名单、SSL 或账号错误 | 先用数据库客户端验证同一组信息；使用只读账号 |
| SQLite 找不到文件 | 路径错误或服务账号无权限 | 使用绝对路径并确认文件存在 |
| 看不到源表/字段 | 只读账号没有元数据权限或选错 schema | 补充必要的表和元数据读取权限 |
| 飞书 401/403 | 凭证错、应用未发布、目标表未授权 | 重新复制凭证，发布应用并把应用加入目标表可访问范围 |
| 飞书字段类型错误 | 目标类型和源值不匹配 | 调整转换方式，并先预览 |
| upsert 提示唯一键错误 | 没选 key、key 没映射或值为空 | 选稳定且不为空的源字段，并确认已映射 |
| 每次运行都重复 | 使用了 append | 改用 upsert，并确认唯一键正确 |
| 日期差几个小时 | 源时区理解不一致 | 统一时区，检查 date 转换后的值 |
| 429 或 5xx | 飞书限流或临时故障 | 客户端会自动重试；仍失败时降低批量大小并稍后重试 |
| 自定义 SQL 被拒绝 | 不是单条只读查询或包含危险语句 | 只用单条 SELECT，参数放 params，不拼接用户输入 |
| 任务失败但写入了一部分 | 批量任务中途失败 | 查看任务日志；修复后用 upsert 重跑，必要时先用测试表 |

端口占用时不要直接结束未知进程。可以先查看：

```powershell
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue
```

确认进程后再决定是否关闭，或直接换一个端口。

## 16. 继续开发：先看目录，再改一小处

普通使用者只需要编辑网页配置，不需要改 `src`。要开发功能，可按这张地图找文件：

```text
项目根目录
├─ public/
│  ├─ index.html       网页结构和文字
│  ├─ styles.css       网页样式
│  └─ app.js           浏览器交互和 API 请求
├─ src/
│  ├─ index.ts         程序入口
│  ├─ config.ts        环境变量读取和校验
│  ├─ server.ts        HTTP API、配置校验、后台任务
│  ├─ store.ts         JSON 文件持久化
│  ├─ security.ts      凭据加密和脱敏
│  ├─ db/              PostgreSQL、MySQL/MariaDB、SQLite 适配器
│  └─ sync/
│     ├─ feishu-client.ts  飞书 Open API 客户端
│     ├─ field-mapping.ts  字段查找和转换
│     └─ sync-service.ts   upsert/append、批量写入、进度
├─ test/               自动化测试
├─ Dockerfile          Docker 镜像构建
└─ docker-compose.example.yml  Docker Compose 示例
```

按需求找文件：

| 想做的事 | 先看哪里 |
| --- | --- |
| 改页面标题、提示文字、表单 | `public/index.html` |
| 改颜色、间距、按钮样式 | `public/styles.css` |
| 改按钮点击行为 | `public/app.js` |
| 增加 HTTP API | `src/server.ts` |
| 增加数据库类型 | `src/db` 和数据库工厂，并补驱动与测试 |
| 增加字段转换 | `src/sync/field-mapping.ts` |
| 修改去重/批量写入 | `src/sync/sync-service.ts` |
| 修改保存格式 | `src/store.ts` |

### 16.1 第一个练习：只改一个页面文字

这是最安全的开发练习，不会碰数据库，也不会写入飞书：

1. 确认已经在项目根目录运行 `pnpm dev`。
2. 用 VS Code 打开 `public/index.html`，搜索页面标题“多维表格 · 数据库同步”。
3. 把它改成你喜欢的文字，例如“订单数据同步工具”，保存文件。
4. 刷新浏览器。网页标题或顶部品牌文字出现新内容，就说明你已经完成了第一次修改。

不要直接编辑 `dist/`：它是构建产物，下次 `pnpm build` 会重新生成。网页修改要改 `public/`，TypeScript 修改要改 `src/`。

### 16.2 改动代码时每个目录负责什么

可以把一次同步想成四个小组接力：

```text
网页 public/ → API server.ts → 数据库适配器 db/ → 同步引擎 sync/ → 飞书
                         ↘ store.ts 保存配置和任务历史
```

例如“增加一个新的字段转换”通常只需要在 `src/sync/field-mapping.ts` 增加转换函数、在 `public/app.js` 增加下拉选项，再在 `test/` 写一个测试；“增加一个数据库”则要同时实现连接、表发现、字段发现、分页读取和驱动加载，不能只改网页下拉框。

如果你还不懂 TypeScript，可以先只看三种东西：函数名（它要做什么）、参数（它需要什么）、返回值（它交出什么）。先复制一个已有的小例子，再逐步改名和改逻辑，比一次写完整模块更容易排错。

推荐开发循环：

1. 先备份 `.data/store.json`，只改一个小目标。
2. 用 `pnpm dev` 启动，修改网页后刷新浏览器。
3. 执行 `pnpm build`，检查 TypeScript 类型。
4. 执行 `pnpm test`，确认自动化测试仍通过。
5. 用测试数据库和测试飞书表重新点一遍四步向导。

如果要增加数据库，先阅读现有适配器和 `DatabaseAdapter` 接口，模仿其连接测试、列出表、读取字段和分页读取；不要只把数据库类型加到下拉框。

## 17. 安全和运维提醒

- 数据库使用专门的只读账号和最小权限，绝不要使用管理员账号。
- 生产必须设置随机、长期保存的 `APP_ENCRYPTION_KEY` 和 `ADMIN_TOKEN`。
- 丢失或更换 `APP_ENCRYPTION_KEY` 会导致已保存凭据无法解密；请纳入备份和交接流程。
- 不要提交 `.env`、`.data/store.json`、`data/` 或日志到 Git，也不要把它们发给别人。
- 远程部署应放在 HTTPS 反向代理后，并限制管理页面和 `/api/*` 的访问来源。
- 单实例 JSON 存储不适合多副本并发写入；扩容前要换成带事务和锁的持久化数据库。
- 同步前备份飞书目标表，尤其是第一次使用 append 或改动映射时。
- 当前没有内置定时、增量和删除同步；上线前明确由外部调度器触发的时间和范围。

## 18. 完成检查清单

- [ ] 浏览器能打开服务地址，右上角显示“服务正常”。
- [ ] 数据库连接测试成功，并出现在“已保存的连接”。
- [ ] 能刷新出源表，选择后能看到字段。
- [ ] 飞书目标表和字段加载成功。
- [ ] 每个需要的字段都有正确映射和转换。
- [ ] upsert 已选择稳定、不为空、已经映射的唯一键；或明确选择 append。
- [ ] 已勾选“仅预览”并检查 10 行数据。
- [ ] 测试表真实同步成功，读取/写入数字符合预期。
- [ ] 密钥已保存到安全位置，没有把密码或 Secret 放进代码仓库。

## 19. 求助时提供什么

请提供：

- 操作步骤和数据库类型。
- Node.js、pnpm 或 npm 版本。
- 终端中的错误原文。
- 是否能访问 `/api/health`。
- 任务 ID（如果已经创建同步任务）。

请务必删除数据库密码、App Secret、App Token、ADMIN_TOKEN 和完整连接字符串。推荐学习顺序是：先用 SQLite 跑通一次 → 理解字段映射 → 阅读 `public/app.js` → 阅读 `src/server.ts` → 阅读 `src/sync/sync-service.ts` → 最后尝试增加数据库适配器或定时调度。
