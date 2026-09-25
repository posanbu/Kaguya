---
title: 真实浏览器测试基础设施调研
description: 核对 Kaguya 现有 Web 测试边界，比较 Vitest Browser、Playwright、Cypress 与 Node Vitest，并提出隔离和验收场景。
---

# 真实浏览器测试基础设施调研

本页回应 [#232](https://github.com/posanbu/Kaguya/issues/232)，核验日期为 **2026-09-25**，仓库基线为 `2dad5c8330a6668e293f79995b2f477ce71ecc61`。建议保留 Node Vitest，并优先用 Playwright Test 验证完整工作台的浏览器行为；如果独立组件交互需求增加，再引入 Vitest Browser 项目。本页没有添加依赖、配置浏览器 CI、运行基准或完成浏览器 PoC，建议不等于已实施。

## 现有测试能证明什么，缺少什么

根配置没有启用 Browser Mode，也没有设置其他 environment，因此沿用 Vitest 默认 Node 环境。配置中的 `maxWorkers: 2` 和 15 秒测试上限用于现有 PGlite 等测试的资源调度，不能直接当成浏览器作业的并发与超时策略。[根配置](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/vitest.config.ts#L10-L18)、[Vitest 默认环境](https://vitest.dev/guide/environment.html)。

Web 已有纯函数、请求封装和 `renderToStaticMarkup` 测试，能够检查路由决策、接口处理和输出结构；静态渲染不会挂载 effect、布局或真实焦点链。当前 CI 执行 lint、typecheck、build、Node 测试分片和 PostgreSQL 集成测试，未配置浏览器安装与截图、浏览器 trace、视频产物。[静态渲染测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.test.tsx)、[开发者页面测试](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/DeveloperConsole.test.ts)、[CI 配置](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/.github/workflows/test.yml)。

缺口与现有实现直接相关：导航守卫协调 `history.go` 与 `popstate`；Inspection effect 在卸载时 abort；API 收到带认证请求的 401 后广播锁屏事件；详情页在移动宽度转移焦点并调用 Clipboard API。纯函数与静态 HTML 断言不能证明这些行为在真实页面中衔接正确。[导航守卫](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/components/AppShell.tsx#L120-L158)、[卸载取消](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/use-inspection.ts#L17-L35)、[401 事件](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/api.ts#L660-L680)、[移动焦点与复制](https://github.com/posanbu/Kaguya/blob/2dad5c8330a6668e293f79995b2f477ce71ecc61/apps/web/src/DeveloperConsole.tsx#L349-L392)。

## 候选框架及其边界

### Node Vitest：继续保留现有低成本契约测试

Node Vitest 适合 Schema、序列化、筛选、游标、路由决策及服务端集成测试。Vitest 采用 MIT；`jsdom`、`happy-dom` 是 Node 中的浏览器环境模拟，官方明确将 Browser Mode 作为独立测试项目能力，两者不能混同。[环境定义](https://vitest.dev/guide/environment.html)、[许可证](https://raw.githubusercontent.com/vitest-dev/vitest/main/LICENSE)。

现有测试通过仍然有价值，但不能把“静态 HTML 中有按钮”写成“按钮能被键盘聚焦并触发正确操作”。加入浏览器层之后，也无需把纯函数和数据库套件迁移到浏览器。

### Vitest Browser：沿用测试生态的组件交互候选

Browser Mode 在真实浏览器中运行测试，可使用 Playwright 或 WebdriverIO provider。Playwright provider 对应 Chromium、Firefox、WebKit；官方提供 React 渲染辅助包和真实浏览器交互 API。若主要问题是 Dialog、Drawer 或某个表单组件的焦点和键盘行为，它能沿用 Vitest 的断言与项目组织。[Browser Mode、provider 与 React 示例](https://vitest.dev/guide/browser/)。

它需要浏览器二进制、provider 依赖及独立项目范围；不能把全部现有 Node 测试直接加 `--browser`。测试代码在浏览器页面中执行，原生阻塞式 `alert/confirm/print` 和模块 mock 有不同限制，因此完整导航、多页面与原生对话框验证仍需评估专门的 E2E runner。当前根配置及浏览器项目之间的资源预算尚未验证。[Browser Mode 限制](https://vitest.dev/guide/browser/#limitations)。

### Playwright Test：完整工作台流程的优先候选

Playwright Test 提供 Chromium、Firefox、WebKit 运行、自动等待、隔离上下文及失败诊断，采用 Apache-2.0。它可从页面外驱动完整应用，更贴合 Kaguya 当前的 History、新标签页、认证失效和响应式详情流程。[安装与浏览器支持](https://playwright.dev/docs/intro)、[许可证](https://github.com/microsoft/playwright/blob/main/LICENSE)。

网络路由可合成响应、延迟或中断请求；Trace Viewer 可回看动作、DOM 快照、console 及网络。代价是维护独立 runner、浏览器安装与应用启动，并区分“真实浏览器加模拟 API”与“真实 Server 集成”；前者不能证明后端持久化或 QQ 投递。API mock 也不是服务器出站网络隔离。[网络控制](https://playwright.dev/docs/network)、[Trace Viewer](https://playwright.dev/docs/trace-viewer)。

### Cypress：交互调试与组件测试可选，但需正视执行模型

Cypress 提供 E2E、组件测试与交互式调试，开源仓库采用 MIT；云端服务能力和商业条款应单独评估，不应与本地 runner 混写。[能力介绍](https://docs.cypress.io/app/get-started/why-cypress)、[runner 许可证](https://github.com/cypress-io/cypress/blob/develop/LICENSE)。

官方限制页说明无法同时控制多个打开的浏览器，但可以通过 `@cypress/puppeteer` 插件测试多个 tab；所以“Cypress 不支持新标签页”过于绝对。其 WebSocket 连接可正常运行，但没有原生逐帧拦截能力。对于 Kaguya，若团队偏好 Cypress 交互调试，应先验证导航、tab 及相关实时行为所需的额外插件与维护成本，再比较是否优于 Playwright。[执行模型与多 tab 边界](https://docs.cypress.io/app/references/trade-offs)。

## 条件建议：先覆盖工作台风险，再决定组件层规模

优先评估 **Node Vitest + Playwright Test**：保留已有服务端与纯逻辑覆盖，通过少量完整页面流程补齐浏览器语义。若后续组件交互用例明显增多，且多数不依赖整页路由，再增加 Vitest Browser；无需一开始同时维护三个浏览器测试框架。这个顺序依据当前覆盖缺口作出，并非基于本次不存在的运行速度或稳定性基准。

最小可行验证应先在一个确定的 Chromium 环境完成，记录实际 Node、runner 和浏览器版本，再决定 Firefox、WebKit 与跨操作系统矩阵。移动 viewport 用于发现响应式布局和焦点问题，不等价于真机 Safari、系统软键盘或所有剪贴板权限行为。

CI 可在未来增加独立浏览器作业，等待应用就绪信号后执行测试，以失败截图和 trace 定位问题；具体版本、缓存策略、并发、时限及产物保留期尚待实现阶段决定。不要把现有 PGlite 套件的并发策略直接复制过去，也不要用固定 sleep、取消关键断言或重复重跑掩盖竞态。

## 数据与网络隔离应先于覆盖扩展

第一批用例建议使用合成 DTO 和专用测试凭据，允许本地应用资源及明确的 mock 请求，其余请求应显式拒绝。对需要真实 Server 的后续用例，应使用独立临时数据目录、数据库和配置，关闭模型及平台出站通道，并在服务器层验证没有外发；浏览器拦截无法控制 Server 进程自身的网络访问。Playwright route 还需考虑 Service Worker 接管请求的情况，不能把“安装了 route”当成完整隔离证据。[网络拦截及 Service Worker 限制](https://playwright.dev/docs/network)。

浏览器 trace 与 Kaguya 产品 Trace 是两种产物：前者用于测试诊断，可能包含页面、请求头和响应体；后者展示业务记录的关联。即便页面 DTO 已脱敏，浏览器 trace 仍可能记录认证头。应在测试源头使用合成数据和无生产效力凭据，上传前检查产物并限制访问与保留期，不采集真实聊天数据。[Trace 网络内容](https://playwright.dev/docs/trace-viewer#network)。

如果保存认证状态文件，它可能含可冒用会话的 cookie 或 header，应排除在 Git 和通用公开产物之外。需要公开复现时重新生成无真实权限的状态，不能把真实状态文件当作普通 fixture。[认证状态警告](https://playwright.dev/docs/auth)。

## 待验证场景与判定标准

以下场景是后续实现清单，本次尚未运行：

- **History 与草稿保护** — 连续打开列表、详情、编辑页，分别执行 back/forward 和取消、确认离开；URL、当前页面、选中项与草稿状态一致，不发生历史栈反复恢复或跳过记录。
- **焦点与键盘** — 用键盘打开 Dialog/Drawer，检查 Tab 范围、Escape 关闭及焦点回到触发元素；移动详情完成加载后焦点到达可感知标题，隐藏内容不会继续截获键盘。
- **链接与新标签页** — 普通点击保持应用导航；修饰键、目标 tab 或复制链接保留预期浏览器语义。测试新 tab 自身的 URL 和内容，而不是仅断言 `href`。
- **取消与过期结果** — 控制响应完成顺序，在查询切换、详情卸载和重新认证之间制造竞态；旧请求取消或其结果被忽略，不能覆盖当前页面。等待请求和可观察状态，不使用任意 sleep。
- **401 锁屏** — 合成请求返回 401 后，锁屏出现、受保护内容不可继续操作；重新认证后恢复约定页面，旧请求不会把上次会话的数据写回。还需独立 Server 测试证明真正无权限请求被拒绝。
- **响应式与 Clipboard** — 以桌面和窄屏检查 master-detail、横向溢出、滚动及返回列表；分别覆盖剪贴板成功、拒绝与不支持的反馈。viewport 测试结果只用于对应模拟环境。
- **失败诊断与隔离** — 人为制造一次失败，确认截图和 trace 可读、没有真实凭据或聊天数据；尝试意外网络请求并确认被阻止。成功执行 UI 用例不能替代这一验证。

框架选定后的实施完成标准是：场景断言可稳定复现、失败产物可定位原因、隔离有证据、最新提交的独立 CI 作业通过。该标准与 #232 的资料调研完成分别记录，不把本页合入写成浏览器覆盖已经补齐。
