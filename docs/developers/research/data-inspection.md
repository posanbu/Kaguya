---
title: 数据库与领域数据检视调研
description: 区分运维数据库工具、普通用户领域投影与 Trace，并比较 DBeaver、pgAdmin、Prisma Studio 和 Supabase Studio 的适用条件。
---

# 数据库与领域数据检视调研

本页回应 [#233](https://github.com/posanbu/Kaguya/issues/233)，核验日期为 **2026-09-25**，仓库基线为 `2dad5c8330a6668e293f79995b2f477ce71ecc61`。结论是保留 Kaguya Inspection API 作为产品检视边界，开发者优先评估独立桌面数据库工具；只有出现明确的集中运维需求，再评估服务器管理界面。本页完成资料与代码调研，没有安装数据库工具、部署管理入口或执行权限 PoC。

## 用户要理解的是记录含义，运维要检查的是存储事实

“模块记住了什么”“某条记录从哪里来”和“这张表有什么索引”属于不同问题。原始表编辑器擅长第三类问题，却不会自动把 Information 引用解释为证据、查询结果和投递状态。把数据库编辑器放进产品，仍然需要补齐模块语义，还会增加绕过领域写入规则的入口。

当前 Inspection 路由只注册 GET，在 `onRequest` 中设置 `Cache-Control: no-store` 并执行认证；服务层使用共享 Schema 校验、统一脱敏并构造投影。记录浏览器沿声明的正反向引用取数，限制候选和分组数量，显式返回截断状态。这是已有实现，不能写成采用第三方管理台后才会获得的能力。[路由与错误处理](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection.ts#L1102-L1141)、[投影与引用边界](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection-records.ts#L36-L76)、[脱敏实现](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection-redaction.ts)。

建议明确三种职责：

- **普通用户领域页面** — 围绕记忆、记录来源和模块状态展示经过认证、脱敏、分页的 DTO；只读检视与自然语言记忆修改各走对应业务入口。数据库列名不应成为用户必须理解的操作概念。
- **Trace 页面** — 围绕一次请求或上下文解释触发、引用与结果的关联，缺失或截断必须可见。Trace 能解释已有记录，不能凭记录推断未落盘的过程，也不能把模型回复完成解释为消息已送达。[请求投影及投递状态测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection-requests.test.ts#L552-L599)。
- **数据库管理工具** — 仅供拥有数据库访问权限的开发者、运维排查表、索引、查询计划和真实行；使用独立数据库身份和网络入口。其访问不会经过 Kaguya Inspection 脱敏，不能因为管理台本身有登录就视为等价授权。

上述是产品与运维职责建议；当前共享管理认证不能据此被描述为已经具有按用户或租户隔离的数据权限体系。

## 候选工具能减少什么工作

### DBeaver Community：独立桌面检视的优先候选

DBeaver 的 Data Editor 支持表、视图和 SQL 结果的网格浏览、筛选及编辑；Community 采用 Apache-2.0，商业版本另有产品边界。适合开发者已获准直连测试 PostgreSQL 时查看实际行、索引和 SQL，不需要把管理服务加入 Kaguya 部署。[Data Editor](https://dbeaver.com/docs/dbeaver/Data-Editor/)、[Community 与许可证](https://dbeaver.io/about/)。

限制在于它展示数据库事实，无法替代模块的中文字段解释与因果引用。建议默认使用数据库侧限制写入的专用账号；客户端“只读”按钮只是额外防误操作措施，不能承担服务端授权。此权限建议尚未在 Kaguya 数据库上验证。

### pgAdmin：PostgreSQL 专项运维与集中访问候选

pgAdmin 支持桌面模式和多用户服务器模式，提供 SQL 查询、执行计划、对象管理及备份恢复等 PostgreSQL 管理能力，采用 PostgreSQL License。若团队需要统一管理 PostgreSQL 实例，其能力比单纯嵌入表格更贴近运维任务。[功能和部署模式](https://www.pgadmin.org/features/)、[许可证](https://www.pgadmin.org/licence/)。

服务器模式会新增独立登录面、数据库凭据保存及服务升级职责。官方支持通过配置接入 Webserver 认证；管理台认证负责进入工具，数据库角色仍决定可读写对象。因此不建议直接复用 Kaguya 普通用户会话来授予数据库管理权限。[Webserver 认证](https://www.pgadmin.org/docs/pgadmin4/9.18/webserver.html)。

### Prisma Studio：可独立使用，也可嵌入，但仍是 SQL 编辑入口

当前 Studio 文档明确支持无 Prisma ORM 的直接数据库连接，并支持 PostgreSQL、MySQL、SQLite；不能沿用“必须先迁移到 Prisma Schema”这一旧前提。嵌入形式使用 `@prisma/studio-core` 的 React `Studio` 组件，由 executor 调用后端 `/studio` 端点执行 SQL。[Studio 当前入口](https://www.prisma.io/docs/studio)、[嵌入架构](https://docs.prisma.io/docs/studio/integrations/embedding)。

这与 Kaguya 的 React 前端形式相容，但**相容不代表已经具备业务授权**。官方示例要求自行在后端补认证及角色限制；把组件隐藏起来不能阻止直接调用 SQL 端点。若日后选择嵌入，仍需独立管理端授权、数据库最小权限、审计和错误脱敏，不能接在普通用户领域浏览器之后。[嵌入指南的生产化要求](https://www.prisma.io/docs/guides/integrations/embed-studio)。

许可证要按实际产物区分：当前嵌入指南与服务条款将免费 Embeddable Studio 描述为 Apache-2.0，并另列保留品牌和遥测条款；旧版本文档仍有 Studio 非开源的说明。这里不把这些产品表述合并为“所有 Studio 均同一许可”。实施前需记录实际选择的包、版本、包内 LICENSE 和适用条款；目前没有选定版本。[嵌入指南](https://www.prisma.io/docs/guides/integrations/embed-studio)、[服务条款第 19 节](https://www.prisma.io/legal/terms)、[旧版本文档](https://www.prisma.io/docs/orm/v6/tools/prisma-studio)。

### Supabase Studio：平台管理台，不能当作零成本表格组件

Supabase 官方 Docker 自托管方案包含 Studio 与配套服务，Studio 通过网关使用 HTTP Basic Authentication，部署方负责设置凭据与 HTTPS。官方同时明确允许移除不需要的 Realtime、Storage、imgproxy、Edge Runtime 等服务，所以“必须部署完整平台所有组件”过于绝对。准确说法是：这是需要管理服务依赖的自托管平台方案，裁剪范围必须按选定部署配置验证。[自托管依赖、认证及 HTTPS](https://supabase.com/docs/guides/self-hosting/docker)。

Supabase 仓库顶层采用 Apache-2.0；实际部署涉及的第三方组件仍需分别核对许可，不能从仓库顶层 LICENSE 推导整套依赖完全相同。对于已经使用 PostgreSQL 的 Kaguya，只为浏览表而引入平台管理台，尚无证据证明运维收益足以覆盖部署、升级和认证成本。若未来本来就使用 Supabase 托管或平台服务，再重新评估 Studio 更合理。[仓库许可证](https://github.com/supabase/supabase/blob/master/LICENSE)。

## Kaguya 的条件建议与待决策项

**近期建议**是先形成 DBeaver Community 的独立开发检视约定；偏 PostgreSQL 专项运维的团队可选择 pgAdmin Desktop。当前开发入口已经管理 PostgreSQL 容器与外部数据库两种路径，检视工具应连接操作者明确选择的开发或测试数据库，而不是自动读取生产连接。[开发 PostgreSQL 装配](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/postgres-development.ts)。这项建议依据部署范围和现有架构作出，未比较两者的实测性能。

**产品方向**是继续为 Inspection 增加用户需要的投影和证据跳转。需要更友好的记忆展示时，应先确认缺的是领域字段、关联查询还是权限范围；嵌入原始表编辑器不能直接解决这些问题。已有 `record-browser` 和请求投影可作为扩展起点，但是否适合每一类新记忆结构仍需逐项设计。

进入实施前，需要确定管理工具的拥有者、数据库角色与网络边界，以及是否存在“必须浏览器集中运维”的实际需求。若没有，该需求不足以支持增加 Prisma SQL 端点或 Supabase 平台服务。若有，应单独批准管理入口的部署与权限设计，而不是把它计为普通领域页的小改动。

## 后续验证场景与完成标准

以下是后续实现的验收建议，本次没有运行这些场景：

- 使用合成数据库和独立账号浏览指定表；尝试写入、DDL 与越权对象读取，确认数据库角色本身拒绝不允许的操作。记录所用工具版本、账号权限和网络入口，避免仅检查 UI 按钮。
- 在领域页面验证无认证拒绝、成功与错误响应 `no-store`、密钥和数据库连接串脱敏、跨筛选复用游标被拒绝，以及同时间记录分页不漏不重。现有测试已提供部分契约样例；增加管理工具不能降低这些约束。[Inspection 测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection.test.ts)、[分页测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/server/src/inspection-records.test.ts#L52-L80)。
- 用来源缺失、错误 Kind、多于上限引用的合成记录验证领域页和 Trace 显示准确的缺失、截断与状态，不借数据库访问绕过投影限制。
- 如选择嵌入或集中运维，直接访问后端管理端点验证认证，而非只测试登录页；检查会话撤销、跨角色访问、日志与遥测中的敏感数据。未完成这些验证前，不能对外宣称该入口可以安全提供给普通用户。

调研可支持关闭 #233 的资料比较工作；工具安装、权限配置、产品页面实现与部署应以独立实现变更及其验收记录为准。
