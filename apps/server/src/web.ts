import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import middie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import type { ServerConfig } from "./config.js";

export interface WebUiHandle {
  close(): Promise<void>;
}

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));

export async function registerWebUi(
  app: FastifyInstance,
  config: Pick<ServerConfig, "development" | "webDistPath">,
): Promise<WebUiHandle> {
  if (config.development) {
    await app.register(middie);
    const vite = await createViteServer({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: { server: app.server },
      },
    });
    app.use((request, response, next) => {
      if (isServerRoute(request.url)) {
        next();
        return;
      }
      vite.middlewares(request, response, next);
    });
    return viteHandle(vite);
  }

  await access(join(config.webDistPath, "index.html"));
  await app.register(fastifyStatic, {
    root: config.webDistPath,
    prefix: "/",
  });
  return { close: () => Promise.resolve() };
}

function isServerRoute(url: string | undefined): boolean {
  const path = url?.split(/[?#]/u, 1)[0] ?? "";
  return path === "/healthz" || path === "/api" || path.startsWith("/api/");
}

function viteHandle(vite: ViteDevServer): WebUiHandle {
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= vite.close();
      return closePromise;
    },
  };
}
