# 记忆联想实时预览

在本工作区根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm preview:association
```

打开 <http://localhost:5189/preview-association.html>。修改 `apps/web/src/RecordSurface.tsx` 或 `record-surface.css` 后，Vite 自动更新页面，可一边查看一边调整。修改 Schema、模块 Manifest 或 Server 投影后，停止命令并重新运行 `pnpm preview:association`，然后刷新页面；该命令会先构建所需包。

预览复用正式页面的 `ModuleSurface`、`RecordSurface`、Schema 与 Inspection API。它使用独立的内存 PGlite 和虚构数据，不需要真实网关 Token、数据库或模型服务。关闭进程后演示账本消失。

顶栏可切换正常记录、空库、读取失败与持续加载。正常记录包括已召回、未召回、策略过滤、检索失败、服务不可用、尚无完成结果、长查询、来源缺失及分页；可以搜索、选择查询、查看来源或候选回执。持续加载模式故意不返回响应，切换模式会取消旧请求。

页面按查询时间显示左侧目录，用带图形的红黄绿状态灯区分结果，悬停可查看含义。右侧优先展示排名候选的原文，再展示召回结果；检索条件默认折叠。来源缺失时明确提示原文不可用，并保留回执入口；来源弹层关闭后保留当前查询并恢复触发按钮焦点。移动端选择记录会聚焦详情，返回按钮可回到目录。候选排名取自账本，不显示不存在的相关度分数，也不把召回解释为进入 Prompt。

本地检查命令：

```sh
pnpm typecheck
pnpm exec vitest run apps/server/src/inspection-records.test.ts apps/server/src/inspection.test.ts packages/schema/src/inspection-surface.test.ts packages/modules/src/first-party/association/surface.test.ts packages/sdk/src/information-modules.test.ts apps/web/src/RecordSurface.test.tsx apps/web/src/ModuleSurface.test.tsx apps/web/src/ModulePages.test.tsx apps/web/src/InspectionFields.test.tsx
pnpm --filter @kaguya/web build
```

预览只监听本机 `127.0.0.1:5189`。此入口不进入正式 Web 构建；正式页面继续使用已认证的开发者接口。
