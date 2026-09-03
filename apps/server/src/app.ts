/**
 * 功能概述：本文件组装 Kaguya 服务端的 Fastify HTTP 应用，承载匿名健康检查、
 * OpenAPI 文档、首屏配置状态查询、带鉴权的全局 Profile Registry 管理接口，以及
 * 窄 Web/Core 消息入口；它是“selected Profile 唯一生效”服务端约束的 HTTP 落点。
 * 主要职责：`createHttpApplication` 统一注册 CORS、限流、OpenAPI 与错误处理，
 * 再根据 `runtime` 与 `setup` 是否存在决定 ready 模式和 setup 模式的可见路由；
 * `/api/v1/setup` 只返回无 secret 的 readiness 元数据；Profile 的创建、读取、
 * 完整替换、显式选择与删除分别由 `/api/v1/profiles*` 路由承载，并统一通过
 * `requireManagementToken` 在任何路径/正文校验前拒绝未授权请求。
 * 代码库关系：本模块消费 `setup.ts` 的 `ConfigurationManagement` 门面与
 * `@kaguya/config` 暴露的 schema 边界、错误码和 Profile 类型；`server.ts`
 * 会把唯一管理实例传入这里，WebUI 与外部管理客户端都通过这些路由驱动 selected
 * Profile，而不是直接访问底层 config manager。
 * 输入输出与副作用：运行时会创建 Fastify 实例并注册中间件；Profile 路由在管理认证
 * 通过后可能写入配置目录并返回无脱敏的 Profile 正文；消息路由仅在 `webGateway`
 * 就绪时非阻塞转发正规化内容，日志不制造 trace ID，否则返回明确的
 * 503 setup-required/core-unavailable 错误。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  ConfigError,
  aiConfigSchema,
  platformConfigSchema,
  pluginConfigSchema,
  profileIdSchema,
} from "@kaguya/config";
import { runWithLogContext } from "@kaguya/logger";
import { z } from "@kaguya/schema";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { ServerConfig } from "./config.js";
import {
  initializeConfigurationProfile,
  type ConfigurationManagement,
} from "./setup.js";
import {
  createEnvironmentGatewayAuthenticator,
  type GatewayAuthenticator,
  type GatewayScope,
} from "./gateway-auth.js";
import { defaultNapCatSettings, toNapCatStatus } from "./napcat-config.js";
import type { WebMessageGateway } from "./web-gateway.js";

const MAX_MESSAGE_TEXT_LENGTH = 131_072;
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const messageRequestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((value) => hasAtMostCodePoints(value, MAX_MESSAGE_TEXT_LENGTH))
      .refine((value) => value.trim().length > 0),
  })
  .strict();

const messageBodyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_MESSAGE_TEXT_LENGTH,
    },
  },
} as const;

const createProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

const initialConfigurationRequestSchema = z
  .object({
    profileName: z.string().trim().min(1).max(100),
    baseUrl: z.string().trim().url(),
    apiKey: z.string().min(1),
    lightModel: z.string().trim().min(1),
    heavyModel: z.string().trim().min(1),
  })
  .strict();

const selectionRequestSchema = z
  .object({
    selectedProfileId: profileIdSchema,
  })
  .strict();

const replaceProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ai: aiConfigSchema,
    platforms: z.array(platformConfigSchema),
    plugins: z.array(pluginConfigSchema),
    acknowledgedWarnings: z.array(z.string().trim().min(1)),
  })
  .strict();

const napCatSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    wsUrl: z.string().trim().optional(),
    accessToken: z.string().optional(),
    selfId: z.string().trim().optional(),
    reconnectMs: z.number().int().min(100).max(3_600_000),
  })
  .strict();

const createProfileRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const initialConfigurationRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profileName", "baseUrl", "apiKey", "lightModel", "heavyModel"],
  properties: {
    profileName: { type: "string", minLength: 1, maxLength: 100 },
    baseUrl: { type: "string", format: "uri" },
    apiKey: { type: "string", minLength: 1 },
    lightModel: { type: "string", minLength: 1 },
    heavyModel: { type: "string", minLength: 1 },
  },
} as const;

const profileIdJsonSchema = {
  anyOf: [{ const: "default" }, { type: "string", format: "uuid" }],
} as const;

const profileMetadataJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "createdAt", "updatedAt"],
  properties: {
    id: profileIdJsonSchema,
    name: { type: "string", minLength: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const configurationIssueJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "message"],
  properties: {
    id: { type: "string", minLength: 1 },
    path: { type: "string" },
    message: { type: "string", minLength: 1 },
  },
} as const;

const modelTierTargetJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "modelId"],
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
  },
} as const;

const aiProviderConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "enabled", "models", "settings"],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    baseUrl: { type: "string", format: "uri" },
    apiKey: { type: "string" },
    models: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    settings: { type: "object", additionalProperties: true },
  },
} as const;

const aiConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providers"],
  properties: {
    defaultProviderId: { type: "string", minLength: 1 },
    modelTiers: {
      type: "object",
      additionalProperties: false,
      required: ["light", "heavy"],
      properties: {
        light: modelTierTargetJsonSchema,
        heavy: modelTierTargetJsonSchema,
      },
    },
    providers: {
      type: "array",
      items: aiProviderConfigJsonSchema,
    },
  },
} as const;

const platformConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "enabled", "credentials", "settings"],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    credentials: { type: "object", additionalProperties: true },
    settings: { type: "object", additionalProperties: true },
  },
} as const;

const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "enabled", "settings"],
  properties: {
    id: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
  },
} as const;

const profileReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acknowledgedWarnings"],
  properties: {
    acknowledgedWarnings: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const userConfigProfileJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "id", "name", "ai", "platforms", "plugins"],
  properties: {
    version: { type: "integer", enum: [1] },
    id: profileIdJsonSchema,
    name: { type: "string", minLength: 1 },
    ai: aiConfigJsonSchema,
    platforms: {
      type: "array",
      items: platformConfigJsonSchema,
    },
    plugins: {
      type: "array",
      items: pluginConfigJsonSchema,
    },
    review: profileReviewJsonSchema,
  },
} as const;

const selectionRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedProfileId"],
  properties: {
    selectedProfileId: profileIdJsonSchema,
  },
} as const;

const profilePathParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profileId"],
  properties: {
    profileId: profileIdJsonSchema,
  },
} as const;

const replaceProfileRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ai", "platforms", "plugins", "acknowledgedWarnings"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    ai: aiConfigJsonSchema,
    platforms: { type: "array", items: platformConfigJsonSchema },
    plugins: { type: "array", items: pluginConfigJsonSchema },
    acknowledgedWarnings: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const setupStatusResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["status", "selectedProfileId", "profiles"],
      properties: {
        status: {
          type: "string",
          enum: [
            "setup_required",
            "invalid",
            "review_required",
            "restart_required",
            "ready",
          ],
        },
        selectedProfileId: profileIdJsonSchema,
        profiles: {
          type: "array",
          items: profileMetadataJsonSchema,
        },
        issues: {
          type: "array",
          items: configurationIssueJsonSchema,
        },
        warnings: {
          type: "array",
          items: configurationIssueJsonSchema,
        },
      },
    },
  },
} as const;

const profileRegistryResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["selectedProfileId", "profiles"],
      properties: {
        selectedProfileId: profileIdJsonSchema,
        profiles: {
          type: "array",
          items: profileMetadataJsonSchema,
        },
      },
    },
  },
} as const;

const profileResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["profile"],
      properties: {
        profile: userConfigProfileJsonSchema,
      },
    },
  },
} as const;

const profileMutationResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["profile", "restartRequired"],
      properties: {
        profile: userConfigProfileJsonSchema,
        restartRequired: { type: "boolean" },
      },
    },
  },
} as const;

const acceptedMessageResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["status", "requestId"],
      properties: {
        status: { type: "string", enum: ["accepted"] },
        requestId: { type: "string" },
      },
    },
  },
} as const;

const errorResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
} as const;

export interface CreateHttpApplicationOptions {
  config: ServerConfig;
  gatewayAuth?: GatewayAuthenticator;
  webGateway?: WebMessageGateway;
  setup?: ConfigurationManagement;
  logger?: FastifyBaseLogger;
}

export async function createHttpApplication(
  options: CreateHttpApplicationOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger === undefined
      ? { logger: false }
      : { loggerInstance: options.logger }),
    bodyLimit: 256 * 1024,
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) =>
      validRequestId(request.headers["x-request-id"]) ?? randomUUID(),
    trustProxy: options.config.trustProxy,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
      },
    },
  });

  app.addHook("onRequest", (request, _reply, done) => {
    runWithLogContext({ requestId: request.id }, done);
  });

  await app.register(cors, {
    origin:
      options.config.corsOrigins.length === 0
        ? false
        : [...options.config.corsOrigins],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
  });
  await app.register(rateLimit, {
    global: true,
    max: options.config.rateLimitMax,
    timeWindow: options.config.rateLimitWindowMs,
    keyGenerator: (request) =>
      `${hasValidGatewayToken(request, options.config.gatewayToken) ? "authenticated" : "unauthenticated"}:${request.ip}`,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Kaguya Application API",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
  });

  app.get(
    "/healthz",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["System"],
        summary: "Check gateway health",
      },
    },
    async () => ({ status: "ok" }),
  );

  app.get(
    "/api/v1/openapi.json",
    {
      config: { rateLimit: false },
      schema: {
        hide: true,
      },
    },
    async () => app.swagger(),
  );

  app.get(
    "/api/v1/setup",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["System"],
        summary: "Inspect first-run configuration readiness",
        response: {
          200: setupStatusResponseJsonSchema,
        },
      },
    },
    async () => {
      const status = (await options.setup?.inspect()) ?? readySetupStatus();
      return { data: status };
    },
  );

  app.post(
    "/api/v1/setup",
    {
      onRequest: requireGatewayToken(options, "setup"),
      schema: {
        tags: ["System"],
        summary: "Complete first-run configuration",
        body: initialConfigurationRequestJsonSchema,
      },
    },
    async (request) => {
      const body = initialConfigurationRequestSchema.parse(request.body);
      const management = requireManagement(options.setup);
      const result = await initializeConfigurationProfile(management, body);
      const gatewayToken = await (options.gatewayAuth ??
        createEnvironmentGatewayAuthenticator(options.config.gatewayToken)
      ).completeBootstrap();
      return { data: { ...result, gatewayToken } };
    },
  );

  app.get(
    "/api/v1/napcat",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: { tags: ["NapCat"], summary: "Read NapCat configuration status" },
    },
    async () => {
      const settings =
        (await requireManagement(options.setup).getNapCatSettings?.()) ??
        defaultNapCatSettings;
      return { data: toNapCatStatus(settings) };
    },
  );

  app.put(
    "/api/v1/napcat",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: { tags: ["NapCat"], summary: "Save NapCat configuration" },
    },
    async (request) => {
      const body = napCatSettingsRequestSchema.parse(request.body);
      const management = requireManagement(options.setup);
      if (
        management.getNapCatSettings === undefined ||
        management.saveNapCatSettings === undefined
      ) {
        throw new Error("NapCat configuration management is unavailable");
      }
      const current = await management.getNapCatSettings();
      const settings = await management.saveNapCatSettings({
        enabled: body.enabled,
        ...(body.wsUrl ? { wsUrl: body.wsUrl } : {}),
        ...(body.accessToken?.trim()
          ? { accessToken: body.accessToken.trim() }
          : current.accessToken === undefined
            ? {}
            : { accessToken: current.accessToken }),
        ...(body.selfId ? { selfId: body.selfId } : {}),
        reconnectMs: body.reconnectMs,
      });
      return {
        data: { status: toNapCatStatus(settings), restartRequired: true },
      };
    },
  );

  app.get(
    "/api/v1/profiles",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "List profile metadata and the selected global profile",
        security: [{ bearerAuth: [] }],
        response: {
          200: profileRegistryResponseJsonSchema,
          401: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async () => ({
      data: await requireManagement(options.setup).listProfiles(),
    }),
  );

  app.post(
    "/api/v1/profiles",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "Create a named profile without selecting it",
        security: [{ bearerAuth: [] }],
        body: createProfileRequestJsonSchema,
        response: {
          201: profileMutationResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          409: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const body = createProfileRequestSchema.parse(request.body);
      const result = await requireManagement(options.setup).createProfile(
        body.name,
      );
      return reply.code(201).send({ data: result });
    },
  );

  app.put(
    "/api/v1/profiles/selection",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "Select the global runtime profile",
        security: [{ bearerAuth: [] }],
        body: selectionRequestJsonSchema,
        response: {
          200: profileMutationResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          404: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request) => {
      const body = selectionRequestSchema.parse(request.body);
      return {
        data: await requireManagement(options.setup).selectProfile(
          parseProfileId(body.selectedProfileId),
        ),
      };
    },
  );

  app.get(
    "/api/v1/profiles/:profileId",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "Read one profile by explicit profile id",
        security: [{ bearerAuth: [] }],
        params: profilePathParamsJsonSchema,
        response: {
          200: profileResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          404: errorResponseJsonSchema,
          409: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request) => {
      const params = profilePathParamsSchema.parse(request.params);
      return {
        data: {
          profile: await requireManagement(options.setup).getProfile(
            parseProfileId(params.profileId),
          ),
        },
      };
    },
  );

  app.put(
    "/api/v1/profiles/:profileId",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "Replace one profile by explicit profile id",
        security: [{ bearerAuth: [] }],
        params: profilePathParamsJsonSchema,
        body: replaceProfileRequestJsonSchema,
        response: {
          200: profileMutationResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          404: errorResponseJsonSchema,
          409: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request) => {
      const params = profilePathParamsSchema.parse(request.params);
      const body = replaceProfileRequestSchema.parse(request.body);
      return {
        data: await requireManagement(options.setup).replaceProfile(
          parseProfileId(params.profileId),
          body,
        ),
      };
    },
  );

  app.delete(
    "/api/v1/profiles/:profileId",
    {
      onRequest: requireGatewayToken(options, "management"),
      schema: {
        tags: ["Profiles"],
        summary: "Delete one non-default, non-selected profile",
        security: [{ bearerAuth: [] }],
        params: profilePathParamsJsonSchema,
        response: {
          204: { type: "null" },
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          404: errorResponseJsonSchema,
          409: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const params = profilePathParamsSchema.parse(request.params);
      await requireManagement(options.setup).deleteProfile(
        parseProfileId(params.profileId),
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/messages",
    {
      onRequest: requireGatewayToken(options, "messages"),
      schema: {
        tags: ["Messages"],
        summary: "Validate and dispatch a message to Kaguya Runtime",
        security: [{ bearerAuth: [] }],
        body: messageBodyJsonSchema,
        response: {
          202: acceptedMessageResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          413: errorResponseJsonSchema,
          415: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
          503: errorResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = messageRequestSchema.parse(request.body);
      const webGateway = options.webGateway;
      if (webGateway === undefined) {
        throw coreUnavailableError(options.setup);
      }
      webGateway.ingest({
        text: parsed.text,
        requestId: request.id,
      });
      request.log.info(
        {
          event: "http.message.accepted",
          requestId: request.id,
        },
        "Message accepted by Web gateway",
      );
      return reply.code(202).send({
        data: {
          status: "accepted",
          requestId: request.id,
        },
      });
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (canServeSpaFallback(request, reply)) {
      return reply.sendFile("index.html");
    }
    return reply
      .code(404)
      .send(errorBody("not_found", "Route not found", request.id));
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (
      isValidationError(error) ||
      error instanceof z.ZodError ||
      isMalformedJsonError(error)
    ) {
      return reply
        .code(400)
        .send(
          errorBody("invalid_request", "Request validation failed", request.id),
        );
    }
    if (error instanceof ApiGatewayError) {
      return reply
        .code(error.statusCode)
        .send(errorBody(error.code, error.message, request.id));
    }
    if (error instanceof ConfigError) {
      const mapped = mapConfigError(error);
      if (mapped !== undefined) {
        return reply
          .code(mapped.statusCode)
          .send(errorBody(mapped.code, mapped.message, request.id));
      }
    }
    if (
      isHttpError(error) &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const rateLimited = error.statusCode === 429;
      return reply
        .code(error.statusCode)
        .send(
          errorBody(
            rateLimited ? "rate_limited" : "request_rejected",
            rateLimited ? "Too many requests" : "Request rejected",
            request.id,
          ),
        );
    }

    request.log.error(
      { event: "http.request.failed", err: error },
      "Unhandled Kaguya HTTP error",
    );
    return reply
      .code(500)
      .send(errorBody("internal_error", "Internal server error", request.id));
  });

  return app;
}

const profilePathParamsSchema = z
  .object({
    profileId: z.string(),
  })
  .strict();

function canServeSpaFallback(
  request: FastifyRequest,
  reply: FastifyReply,
): reply is FastifyReply & { sendFile(path: string): FastifyReply } {
  const path = request.url.split(/[?#]/u, 1)[0] ?? "";
  return (
    request.method === "GET" &&
    request.headers.accept?.includes("text/html") === true &&
    path !== "/healthz" &&
    !path.startsWith("/api/") &&
    "sendFile" in reply &&
    typeof reply.sendFile === "function"
  );
}

class ApiGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApiGatewayError";
  }
}

function coreUnavailableError(
  setup: ConfigurationManagement | undefined,
): ApiGatewayError {
  return new ApiGatewayError(
    setup === undefined ? "core_unavailable" : "configuration_setup_required",
    setup === undefined
      ? "Core message ingress is not configured"
      : "Configuration must be completed before messages can be processed",
    503,
  );
}

function requireGatewayToken(
  options: CreateHttpApplicationOptions,
  scope: GatewayScope,
) {
  const authenticator =
    options.gatewayAuth ??
    createEnvironmentGatewayAuthenticator(options.config.gatewayToken);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization?.trim() ?? "";
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
    const suppliedToken = match?.[1]?.trim() ?? "";
    if (!(await authenticator.authorize(suppliedToken, scope))) {
      return reply
        .code(401)
        .send(
          errorBody(
            "unauthorized",
            "A valid gateway Bearer token is required",
            request.id,
          ),
        );
    }
  };
}

function requireManagement(
  setup: ConfigurationManagement | undefined,
): ConfigurationManagement {
  if (setup === undefined) {
    throw new ApiGatewayError(
      "configuration_unavailable",
      "Configuration store is unavailable",
      409,
    );
  }
  return setup;
}

function parseProfileId(profileId: string) {
  const parsed = profileIdSchema.safeParse(profileId);
  if (!parsed.success) {
    throw new ConfigError("CONFIG_INVALID_INPUT", "Profile ID is invalid");
  }
  return parsed.data;
}

function readySetupStatus() {
  return {
    status: "ready" as const,
    selectedProfileId: "default",
    profiles: [
      {
        id: "default",
        name: "default",
        createdAt: "",
        updatedAt: "",
      },
    ],
  };
}

function mapConfigError(error: ConfigError) {
  switch (error.code) {
    case "CONFIG_INVALID_INPUT":
      return {
        statusCode: 400,
        code: "profile_invalid",
        message: "Profile input is invalid",
      } as const;
    case "CONFIG_PROFILE_NOT_FOUND":
      return {
        statusCode: 404,
        code: "profile_not_found",
        message: "Profile was not found",
      } as const;
    case "CONFIG_PROFILE_NAME_CONFLICT":
      return {
        statusCode: 409,
        code: "profile_name_conflict",
        message: "Profile name already exists",
      } as const;
    case "CONFIG_DEFAULT_PROFILE_PROTECTED":
      return {
        statusCode: 409,
        code: "profile_protected",
        message: "The default profile is protected",
      } as const;
    case "CONFIG_PROFILE_IN_USE":
      return {
        statusCode: 409,
        code: "profile_in_use",
        message: "The selected profile cannot be deleted",
      } as const;
    default:
      return undefined;
  }
}

function hasValidGatewayToken(
  request: FastifyRequest,
  expectedToken: string,
): boolean {
  const authorization = request.headers.authorization?.trim() ?? "";
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
  if (match === null) {
    return false;
  }
  const suppliedToken = match[1]?.trim() ?? "";
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

function validRequestId(value: string | string[] | undefined) {
  return typeof value === "string" &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) {
      return false;
    }
  }
  return true;
}

function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    error.validation !== undefined
  );
}

function isMalformedJsonError(error: unknown): boolean {
  return (
    isHttpError(error) &&
    error.statusCode === 400 &&
    "code" in error &&
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  );
}

function isHttpError(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}
