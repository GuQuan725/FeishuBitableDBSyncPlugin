# 开发技术栈与学习路线

## 这份文档解决什么问题

“数据库同步到飞书多维表格”看起来像一个功能，实际上由多个小技术拼起来：

1. 网页让人填写配置。
2. 后端接收配置并启动任务。
3. 数据库适配器读取不同数据库。
4. 字段映射把一种数据格式变成另一种格式。
5. 飞书 API 把数据批量写入多维表格。
6. 任务系统处理进度、重试、取消和失败。
7. 测试、安全和部署保证服务能长期运行。

不需要一开始把所有内容学完。推荐路线是：

~~~text
先会运行 → 能读懂代码 → 能改一个小功能 → 能增加能力 → 能部署维护
~~~

## 一、先判断需要学到什么程度

| 目标 | 需要掌握的内容 | 暂时不用掌握 |
| --- | --- | --- |
| 只使用这个项目 | Windows 命令、环境变量、飞书配置、数据库基本概念 | TypeScript、算法、Docker |
| 能维护页面和配置 | HTML、CSS、JavaScript、HTTP 基础 | 复杂数据库优化、分布式系统 |
| 能增加字段转换或 API | TypeScript、Node.js、JSON、测试 | Kubernetes、消息队列 |
| 能增加数据库适配器 | SQL、数据库驱动、分页、错误处理 | 前端框架 |
| 做成稳定的商业服务 | 安全、HTTPS、部署、监控、定时和增量同步 | 与当前需求无关的技术 |

普通使用者不需要修改代码。第一次请先按 [BEGINNER_GUIDE.md](BEGINNER_GUIDE.md) 跑通 SQLite 和网页向导。

## 二、项目用到哪些技术

### 1. HTML、CSS 和 JavaScript

作用：制作浏览器里的四步配置向导。

- HTML：表单、按钮、选择框、表格。
- CSS：颜色、布局、响应式页面。
- JavaScript：读取输入、调用 API、更新页面、轮询任务状态。

项目文件：

- public/index.html：页面结构和文字。
- public/styles.css：颜色、间距、按钮和布局。
- public/app.js：浏览器交互和 fetch 请求。

你需要学会：

- 表单元素和事件监听。
- DOM 查询和修改。
- 数组、对象、模板字符串。
- fetch、Promise、async/await。
- JSON 的序列化和解析。

### 2. TypeScript

作用：编写带类型检查的后端代码，减少“字段写错”这类问题。

项目里常见的 TypeScript 内容：

- interface：描述连接、映射、任务等对象的形状。
- 联合类型：限制数据库类型只能是 PostgreSQL、MySQL 或 SQLite。
- 泛型：让读取任意行数据的函数保持类型安全。
- async/await：处理数据库和网络请求。
- Error：把错误传到 API 和任务日志。

项目文件：

- src/**/*.ts
- test/**/*.ts

先学普通 JavaScript，再学 TypeScript。不要一开始背所有类型语法；看到项目中的一个接口，就问自己“这个对象必须有哪些字段”。

### 3. Node.js

作用：让 JavaScript 在服务器上运行，并提供文件、网络和进程能力。

本项目使用 Node.js 内置的 `node:http` 创建服务，没有依赖 Express、NestJS 等大型后端框架；这让初学者可以直接看到请求是怎样被路由和处理的。

项目使用 Node.js：

- 启动 HTTP 服务。
- 读取环境变量。
- 读写 .data/store.json。
- 加载数据库驱动。
- 创建和关闭后台任务。
- 运行编译后的 dist/src/index.js。

项目入口：

- src/index.ts：加载配置、创建服务、监听端口。
- src/config.ts：校验端口、密钥和数据文件路径。
- src/server.ts：处理 HTTP 路由。

需要理解：

- package.json 的 scripts 和依赖。
- ES module 的 import / export。
- Promise 和事件循环。
- 进程环境变量。
- 文件路径和跨平台路径。

### 4. npm、pnpm 和终端

作用：安装依赖、运行开发服务器、编译和测试。

常用命令：

~~~powershell
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm start
~~~

如果使用 npm，对应命令是 npm install、npm run dev、npm run build、npm test、npm start。

PowerShell、命令提示符和 Linux Shell 的写法不完全相同。本文项目的 Windows 示例统一使用 PowerShell。环境变量、.env 和首次启动的注意事项请看 BEGINNER_GUIDE.md。

### 5. SQL 和数据库

作用：从 PostgreSQL、MySQL/MariaDB、SQLite 读取数据。

需要掌握的 SQL：

- SELECT
- WHERE
- ORDER BY
- LIMIT
- JOIN
- 聚合函数 COUNT、SUM
- NULL
- 主键和唯一索引
- 数据类型和时区

项目把不同数据库统一成相似的动作：

~~~text
连接 → 测试连接 → 列出表 → 读取字段 → 分页读取记录 → 关闭连接
~~~

项目文件：

- src/db/base.ts：适配器的共同接口。
- src/db/types.ts：连接和读取选项类型。
- src/db/factory.ts：根据类型选择适配器。
- src/db/postgres.ts：PostgreSQL。
- src/db/mysql.ts：MySQL/MariaDB。
- src/db/sqlite.ts：SQLite。
- src/db/security.ts：只读 SQL 检查、标识符校验和参数绑定。

数据库适配器目录还有 [src/db/README.md](src/db/README.md)，适合作为第一次阅读适配器接口的入口。

安全重点：项目默认只读数据库，不允许把用户输入直接拼进 SQL；值应通过参数传入。

### 6. HTTP、REST 和飞书开放 API

作用：让浏览器、插件服务和飞书互相发送数据。

要理解：

- GET：读取信息。
- POST：创建或执行操作。
- DELETE：删除或停用资源。
- 请求头：例如 Authorization。
- 请求体：通常是 JSON。
- 状态码：200 成功、202 已排队、400 参数错误、401 未授权、403 无权限、500 服务错误。
- 分页：一次只取一部分数据。
- 批量：一次写入多条记录。
- 重试：遇到 429 或临时 5xx 时稍后再试。

项目文件：

- src/server.ts：本地 HTTP API。
- src/sync/feishu-client.ts：飞书 API 客户端。
- public/app.js：浏览器调用本地 API。

飞书客户端使用 HTTP REST 和 Node.js 的 fetch，并不是一个封装好所有业务的前端 SDK；因此阅读接口文档、查看请求和响应是学习重点。

飞书侧还要理解：

- 企业自建应用。
- App ID 和 App Secret。
- 租户访问令牌。
- App Token 和数据表 ID。
- 多维表格字段和记录权限。

参考：[飞书开放平台文档](https://open.feishu.cn/document/)。

### 7. 同步系统设计

这是本项目最核心的业务技术。

一次同步可以拆成：

~~~text
读取数据库记录
  ↓
按 mappings 找到源字段
  ↓
转换文本、数字、日期、布尔或 JSON
  ↓
检查唯一键
  ↓
判断新增还是更新
  ↓
按最多 500 条分批写入飞书
  ↓
更新进度和日志
~~~

项目文件：

- src/sync/types.ts：同步配置、字段、记录和错误类型。
- src/sync/field-mapping.ts：取值、转换、默认值和映射错误。
- src/sync/sync-service.ts：upsert、append、分页、批量写入、重试配合和取消。

必须理解的概念：

- 字段映射：源字段名和目标字段名可以不同。
- 转换：数据库时间可能要变成 Unix 毫秒，数字字符串可能要变成数字。
- 唯一键：稳定识别同一行，例如订单 ID。
- upsert：找到相同唯一键就更新，否则新增。
- append：不判断旧记录，每次都新增。
- 幂等性：同一批数据重复运行，结果尽量不发生额外变化。
- 分页：大表不能一次全部放进内存。
- 批量写入：飞书接口有单批数量上限。
- 部分失败：前几批成功、后几批失败时，要记录状态并能安全重跑。

这里要区分“按页读取”和“完全流式处理”：本项目从数据库按页读取，但当前同步会保留映射后的行，并在 upsert 时读取目标记录来做匹配。超大表上线前要评估内存占用、批次大小和并发策略。

`dryRun` 会继续读取并映射源数据，只跳过写入飞书；通过本服务网页运行时不会调用飞书 API，upsert 的分类会按空目标表模拟。因此 dry-run 适合检查格式和映射，不等同于真实写入前的完整冲突检查。

### 8. 测试和调试

作用：在连接真实数据库和飞书前，先确认逻辑正确。

项目测试：

- test/core.test.ts：加密、存储、映射、同步核心逻辑。
- test/db-adapters.test.ts：数据库适配器和只读 SQL。
- test/server.test.ts：HTTP 路由、认证、后台任务。

需要学习：

- 如何读错误堆栈。
- 如何写一个最小测试。
- 如何用测试数据覆盖空值、重复键、错误类型和取消任务。
- 为什么先写测试再改代码更容易定位问题。

每次改动后运行：

~~~powershell
pnpm build
pnpm test
~~~

### 9. Git 和版本管理

作用：保存每次改动，方便回退和多人协作。

初学者先学：

- git init、git clone
- git status
- git add
- git commit
- 分支和合并
- .gitignore

敏感文件必须排除：

- .env
- .data/store.json
- data/
- 日志和临时文件

参考：[Pro Git 中文版](https://git-scm.com/book/zh/v2)。

### 10. 安全和部署

作用：让服务能够安全地放在服务器上。

需要逐步学习：

- 环境变量和密钥管理。
- 最小权限数据库账号。
- HTTPS 和反向代理。
- SQL 注入防护。
- API 认证。
- AES-GCM 加密的基本用途。
- 文件权限、备份和日志。
- Docker 镜像和 Compose。
- Windows 任务计划程序或 Linux cron。

项目相关文件：

- src/security.ts：凭据加密和脱敏。
- src/db/security.ts：只读 SQL 和标识符安全。
- Dockerfile：容器镜像。
- docker-compose.example.yml：容器启动示例。

### 项目整体结构

把一次网页操作想成下面这条请求链路：

~~~text
浏览器（public/app.js）
          ↓ HTTP/JSON
Node 内置 HTTP 服务（src/server.ts）
     ↙          ↓             ↘
数据库适配器   同步引擎       JsonStore
（src/db）    （src/sync）   （src/store.ts）
                  ↓
            飞书 REST API
~~~

`src/server.ts` 会把同步工作放到当前进程的后台任务中，网页不必一直等待请求。它不是持久化消息队列；服务进程重启时，正在运行的任务可能会中断。因此学习部署时要同时理解任务状态、日志和恢复策略。

## 三、推荐学习顺序

### 第 1 阶段：命令行、文件和 JSON

学习内容：

- 文件夹、绝对路径、相对路径。
- PowerShell 的 cd、Get-ChildItem、Get-Content。
- JSON 对象、数组、字符串和数字。
- 环境变量是什么。

在项目中的练习：

~~~powershell
cd D:\projects\MultiDTableDBLinkPlugin
Get-ChildItem
Get-Content package.json
~~~

完成标准：能进入项目根目录、找到 package.json、运行一个 pnpm 命令。

### 第 2 阶段：HTML 和 CSS

学习内容：

- 标签、属性、表单。
- class 和 CSS 选择器。
- Flexbox 和 Grid。
- 响应式布局。

练习：

1. 打开 public/index.html。
2. 修改页面标题或一个按钮文字。
3. 用 public/styles.css 修改按钮颜色。
4. 运行 pnpm dev 并刷新浏览器。

完成标准：能独立修改一个页面元素，并知道改动来自哪个文件。

### 第 3 阶段：JavaScript 和浏览器 API

学习内容：

- 变量、函数、数组、对象。
- map、find、filter。
- 事件监听。
- fetch。
- Promise、async/await。
- 错误提示和表单校验。

练习：

1. 在浏览器控制台执行一个简单数组操作。
2. 阅读 public/app.js 的 api 函数。
3. 找到“刷新数据表”按钮的事件处理。
4. 修改成功提示文字。
5. 增加一个不会写入数据的前端校验。

完成标准：能说清楚“点击按钮后，浏览器发了哪个 URL 的请求”。

### 第 4 阶段：TypeScript 和 Node.js

学习内容：

- import / export。
- 接口和类型。
- Promise 和异常。
- package.json scripts。
- HTTP 请求和响应。
- 文件读写。

阅读顺序：

~~~text
src/index.ts
  → src/config.ts
  → src/server.ts
  → src/store.ts
~~~

练习：

1. 在安全的测试分支中加入一个简单日志。
2. 阅读 /api/health 路由。
3. 阅读一个 GET 路由和一个 POST 路由的区别。
4. 修改后运行 pnpm build。

完成标准：能从浏览器请求追踪到 src/server.ts 中的处理函数。

### 第 5 阶段：SQL 和 SQLite

学习内容：

- 创建表、插入记录、查询记录。
- 主键、唯一键和 NULL。
- JOIN 和分页。
- 数据库日期和时区。

练习：

1. 用 SQLite 建立 orders 表。
2. 插入两行测试数据。
3. 在网页中发现表和字段。
4. 预览数据并比较数据库中的原值。

完成标准：能解释一行数据如何从 SQLite 进入网页预览。

### 第 6 阶段：HTTP 和飞书 API

学习内容：

- JSON 请求。
- Authorization 请求头。
- API 状态码。
- 分页和批量。
- 飞书应用权限。

练习：

1. 访问 /api/health。
2. 用浏览器开发者工具查看网络请求。
3. 用 PowerShell 或 Postman 调用一个只读 API。
4. 阅读 src/sync/feishu-client.ts 中的列表和批量写入函数。
5. 在测试表中完成一次 dry-run。

完成标准：能看懂一次“浏览器 → 本地服务 → 飞书”的请求链路。

### 第 7 阶段：同步算法

学习内容：

- 映射和转换。
- 唯一键和幂等性。
- upsert 与 append。
- 批量、分页、重试。
- 取消和部分失败。

阅读顺序：

~~~text
src/sync/types.ts
  → src/sync/field-mapping.ts
  → src/sync/sync-service.ts
  → src/server.ts 的同步任务部分
~~~

练习：

1. 把 amount 映射为数字。
2. 把 created_at 映射为日期。
3. 用 id 做 upsert 唯一键。
4. 重复运行，确认不会创建重复记录。
5. 故意放入一个无法转换的值，观察跳过和日志。

完成标准：能说明一行记录为什么被新增、更新或跳过。

### 第 8 阶段：测试

学习内容：

- 测试输入、预期输出。
- 测试错误和边界条件。
- 测试数据库适配器。
- HTTP 集成测试。

练习：

1. 先阅读一个已有测试。
2. 为一个新的转换规则添加正常值测试。
3. 添加空值和错误值测试。
4. 运行 pnpm test。

完成标准：新增功能有自动化测试，且原有测试仍然通过。

### 第 9 阶段：安全和部署

学习内容：

- 密钥不能写进代码。
- 数据库账号最小权限。
- HTTPS、反向代理和管理 API 认证。
- Docker 和数据卷。
- 备份、日志和恢复。

练习：

1. 检查 .gitignore。
2. 用 Docker Compose 在测试环境启动。
3. 观察重启后配置是否仍在。
4. 模拟错误密钥，理解为什么无法解密旧凭据。
5. 写一份部署和恢复步骤。

完成标准：能说明服务如何保护密钥、数据文件和管理接口。

## 四、按项目文件学习

| 文件或目录 | 建议先学什么 | 适合做的练习 |
| --- | --- | --- |
| public/index.html | HTML 表单 | 改标题、增加说明 |
| public/styles.css | CSS 布局 | 改颜色和间距 |
| public/app.js | JavaScript、fetch | 改提示、加校验 |
| src/index.ts | Node.js 入口 | 理解启动流程 |
| src/config.ts | 环境变量、校验 | 增加一个安全配置 |
| src/server.ts | HTTP 路由、任务状态 | 增加只读 API |
| src/db/ | 接口、驱动、SQL | 阅读 SQLite，再比较 MySQL |
| src/sync/field-mapping.ts | 函数和转换 | 增加一个转换规则 |
| src/sync/sync-service.ts | 算法和批处理 | 跟踪一次 upsert |
| src/store.ts | JSON 持久化 | 阅读配置如何保存 |
| test/ | 自动化验证 | 为改动补测试 |

推荐完整阅读顺序：

~~~text
README.md
  → BEGINNER_GUIDE.md
  → public/app.js
  → src/sync/types.ts
  → src/sync/field-mapping.ts
  → src/sync/sync-service.ts
  → src/db/base.ts 和 src/db/types.ts
  → src/db/sqlite.ts
  → src/server.ts
  → test/
~~~

## 五、一个可靠的开发循环

每次做功能都按下面的顺序，不要同时改很多文件：

1. 写下目标：例如“增加一个金额格式转换”。
2. 找到入口：网页、API、同步引擎还是数据库适配器。
3. 先看现有实现：找一个最相似的功能。
4. 设计最小改动：先处理正常情况。
5. 补边界条件：空值、错误值、重复值、权限错误。
6. 写或更新测试。
7. 运行构建和测试：

   ~~~powershell
   pnpm build
   pnpm test
   ~~~

8. 在测试数据库和测试飞书表手动验证。
9. 记录改了什么、如何回退。
10. 再提交 Git。

遇到错误时，先看终端里的第一条完整错误；浏览器最后显示的“同步失败”通常只是结果，不是原因。

## 六、建议完成的实践项目

按难度递增：

### 练习 1：修改页面

目标：修改标题、按钮文字和颜色。

涉及：HTML、CSS、开发服务器。

### 练习 2：增加只读健康信息

目标：增加一个显示服务版本的只读 API 和页面文字。

涉及：JavaScript、HTTP、src/server.ts。

### 练习 3：增加字段转换

目标：增加一种安全的字符串或数字转换，并为它写测试。

涉及：TypeScript、映射、测试。

### 练习 4：SQLite 到飞书

目标：创建 orders 表，完成 dry-run、upsert 和真实同步。

涉及：SQL、映射、飞书权限、任务状态。

### 练习 5：增加数据库能力

目标：模仿现有适配器，接入另一种数据库或数据库特性。

必须补齐：

- 连接和关闭。
- 连接测试。
- 列出表。
- 描述字段。
- 分页读取。
- 错误转换。
- 只读和参数化检查。
- 单元测试。

### 练习 6：增加定时同步

目标：由 Windows 任务计划程序或 Linux cron 定时调用 POST /api/sync-runs。

上线前还要考虑：

- 同一配置不能重复并发运行。
- 任务失败如何重试。
- 如何通知管理员。
- 如何记录增量游标。
- 如何同步删除。

## 七、推荐学习资料

按学习阶段选择，不要一次打开几十个教程：

- Web 基础：[MDN Web 开发文档](https://developer.mozilla.org/zh-CN/docs/Web)。
- JavaScript：[MDN JavaScript 指南](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide)。
- TypeScript：[TypeScript 中文手册](https://www.typescriptlang.org/zh/docs/)。
- Node.js：[Node.js 学习资源](https://nodejs.org/zh-cn/learn)。
- SQL：[SQLBolt](https://sqlbolt.com/)。
- Git：[Pro Git 中文版](https://git-scm.com/book/zh/v2)。
- Docker：[Docker Get Started](https://docs.docker.com/get-started/)。
- 飞书：[飞书开放平台文档](https://open.feishu.cn/document/)。

学习资料的用法：

1. 只选当前阶段的一篇资料。
2. 看完一个概念，马上在项目或小文件里练习。
3. 练习成功后再看下一个概念。
4. 把遇到的错误和解决方法记在项目的开发笔记中。

## 八、目前不必急着学习的技术

本项目当前使用原生 HTML、CSS、JavaScript 和 Node.js，因此初学阶段不需要马上学习：

- React、Vue 或其他前端框架。
- NestJS、Spring 等大型后端框架。
- Redis、Kafka、Kubernetes。
- 微服务和服务网格。
- 复杂算法和机器学习。
- 一开始就做多副本高可用。

这些技术在规模变大时可能有用，但会分散初学者对“读取、映射、写入”主链路的注意力。

## 九、完成标准

### 能使用

- [ ] 能安装 Node.js 和 pnpm/npm。
- [ ] 能启动服务并访问网页。
- [ ] 能配置数据库连接和飞书应用。
- [ ] 能完成一次仅预览和一次真实同步。
- [ ] 能解释 upsert、append 和唯一键。

### 能维护

- [ ] 能读懂 public/app.js 的一次请求。
- [ ] 能读懂 src/server.ts 的一个路由。
- [ ] 能修改一个页面文字或样式。
- [ ] 能修改一个字段映射规则。
- [ ] 能运行并理解 pnpm build 和 pnpm test。

### 能扩展

- [ ] 能为新功能写测试。
- [ ] 能增加一个转换器。
- [ ] 能增加一个只读 API。
- [ ] 能阅读并模仿数据库适配器。
- [ ] 能处理分页、重试、取消和部分失败。

### 能部署

- [ ] 能使用随机密钥和管理令牌。
- [ ] 能配置 HTTPS 和访问限制。
- [ ] 能备份并恢复数据文件。
- [ ] 能用 Docker 或系统服务启动。
- [ ] 能说明定时、增量和删除同步的设计方案。

## 十、学习时最重要的原则

- 先跑通，再理解；先理解，再扩展。
- 一次只改一个小目标。
- 先在 SQLite 和测试飞书表实验。
- 不把密码、Secret 或令牌写进代码。
- 不要为了“看起来高级”而提前引入大型框架。
- 错误信息是学习材料，保留原文并记录解决过程。
- 每次改动都运行构建和测试。
