/**
 * 功能概述：启动 #190 的本地热更新预览，用真实只读 Inspection API 读取隔离的演示账本。
 * 主要职责：main 准备两个内存 PGlite 库，Vite 承载正式 React 组件并转发 GET 至 Fastify 注入接口；信号退出关闭全部资源。
 * 代码库关系：根 preview:arousal 命令调用本入口，arousal-fixture 提供数据，前端 preview-arousal.html 提供状态切换。
 * 输入输出与副作用：只监听 127.0.0.1:5190；不读取用户配置或生产库、不调用模型；preview-* 标记仅用于此独立进程的演示状态。
 */
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "vite";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "../inspection.js";
import { arousalPreviewModule, seedArousalPreview } from "./arousal-fixture.js";
async function main() {
  const databases = [
    await createTestingDatabase(),
    await createTestingDatabase(),
  ];
  const apps: FastifyInstance[] = [];
  for (const [index, database] of databases.entries()) {
    await database.prepareSchema();
    if (index === 0) await seedArousalPreview(database);
    const app = Fastify();
    registerInspectionRoutes(
      app,
      createInspectionService({
        ledger: database.information,
        modules: () => [arousalPreviewModule],
        secrets: {},
      }),
      async () => {},
    );
    await app.ready();
    apps.push(app);
  }
  const root = fileURLToPath(new URL("../../../web/", import.meta.url));
  const vite = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    server: { host: "127.0.0.1", port: 5190, strictPort: true },
    plugins: [
      {
        name: "arousal-preview",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url === "/__preview/module") {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(arousalPreviewModule));
              return;
            }
            if (!req.url?.startsWith("/api/v1/inspection/")) return next();
            const state = req.headers.authorization;
            if (state === "Bearer preview-loading") return;
            if (state === "Bearer preview-error") {
              res.statusCode = 503;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: { code: "preview_error" } }));
              return;
            }
            if (req.method !== "GET") {
              res.statusCode = 405;
              res.end();
              return;
            }
            try {
              const response = await apps[
                state === "Bearer preview-empty" ? 1 : 0
              ]!.inject({ method: "GET", url: req.url });
              res.statusCode = response.statusCode;
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(response.body);
            } catch {
              res.statusCode = 500;
              res.end();
            }
          });
        },
      },
    ],
  });
  await vite.listen();
  console.log("注意力唤醒实时预览：http://localhost:5190/preview-arousal.html");
  const close = async () => {
    await vite.close();
    await Promise.all(apps.map((app) => app.close()));
    await Promise.all(databases.map((database) => database.close()));
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
await main();
