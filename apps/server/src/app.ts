import { randomUUID, timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { ConfigError } from "@kaguya/config";
import { runWithLogContext } from "@kaguya/logger";
import type { RuntimeWebMessage } from "@kaguya/runtime";
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
  isConfigurationInputError,
  type ConfigurationSetup,
  type InitialConfigurationInput,
} from "./setup.js";

const MAX_SESSION_ID_LENGTH = 256;
const MAX_MESSAGE_TEXT_LENGTH = 131_072;
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const messageRequestSchema = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .refine((value) => hasAtMostCodePoints(value, MAX_SESSION_ID_LENGTH))
      .transform((value) => value.trim())
      .refine((value) => value.length > 0),
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
  required: ["sessionId", "text"],
  properties: {
    sessionId: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SESSION_ID_LENGTH,
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_MESSAGE_TEXT_LENGTH,
    },
  },
} as const;

const setupRequestSchema = z
  .object({
    profileName: z.string().trim().min(1).max(100),
    baseUrl: z.string().trim().url(),
    apiKey: z.string().min(1).max(4096),
    lightModel: z.string().trim().min(1).max(256),
    heavyModel: z.string().trim().min(1).max(256),
    acknowledgeOptional: z.boolean(),
  })
  .refine(({ lightModel, heavyModel }) => lightModel !== heavyModel, {
    message: "Light and heavy models must be different",
    path: ["heavyModel"],
  })
  .strict();

const setupRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "profileName",
    "baseUrl",
    "apiKey",
    "lightModel",
    "heavyModel",
    "acknowledgeOptional",
  ],
  properties: {
    profileName: { type: "string", minLength: 1, maxLength: 100 },
    baseUrl: { type: "string", format: "uri" },
    apiKey: { type: "string", minLength: 1, maxLength: 4096 },
    lightModel: { type: "string", minLength: 1, maxLength: 256 },
    heavyModel: { type: "string", minLength: 1, maxLength: 256 },
    acknowledgeOptional: { type: "boolean" },
  },
} as const;

const setupResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["status", "restartRequired"],
      properties: {
        status: { type: "string", enum: ["configured"] },
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
  runtime?: RuntimeDispatcher;
  setup?: ConfigurationSetup;
  logger?: FastifyBaseLogger;
}

export interface RuntimeDispatcher {
  dispatch(message: RuntimeWebMessage): Promise<unknown>;
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
    methods: ["GET", "POST"],
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
        hide: true,
        tags: ["System"],
        summary: "Inspect first-run configuration readiness",
      },
    },
    async () => ({
      data: (await options.setup?.inspect()) ?? { status: "ready" as const },
    }),
  );

  app.post(
    "/api/v1/setup",
    {
      onRequest: async (request, reply) => {
        if (!hasValidGatewayToken(request, options.config.gatewayToken)) {
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
      },
      schema: {
        hide: true,
        tags: ["System"],
        summary: "Initialize the first configuration profile",
        security: [{ bearerAuth: [] }],
        body: setupRequestJsonSchema,
        response: {
          201: setupResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          409: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const setup = options.setup;
      if (setup === undefined) {
        throw new ApiGatewayError(
          "configuration_not_required",
          "Configuration setup is not required",
          409,
        );
      }
      const setupStatus = await setup.inspect();
      if (
        setupStatus.status === "ready" ||
        setupStatus.status === "restart_required"
      ) {
        throw new ApiGatewayError(
          "configuration_not_required",
          "Configuration setup is not required",
          409,
        );
      }
      const parsed = setupRequestSchema.parse(request.body);
      try {
        await setup.initialize(parsed satisfies InitialConfigurationInput);
      } catch (error) {
        if (isConfigurationInputError(error)) {
          throw new ApiGatewayError(
            "configuration_invalid",
            "Configuration input is invalid or incomplete",
            400,
          );
        }
        if (
          error instanceof ConfigError &&
          error.code === "CONFIG_CORRUPT_STORE"
        ) {
          throw new ApiGatewayError(
            "configuration_unavailable",
            "Configuration store is unavailable",
            409,
          );
        }
        throw error;
      }
      request.log.info(
        { event: "configuration.setup.completed" },
        "Configuration saved; restart required",
      );
      return reply.code(201).send({
        data: { status: "configured", restartRequired: true },
      });
    },
  );

  app.post(
    "/api/v1/messages",
    {
      onRequest: async (request, reply) => {
        if (!hasValidGatewayToken(request, options.config.gatewayToken)) {
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
      },
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
      const runtime = options.runtime;
      if (runtime === undefined) {
        throw new ApiGatewayError(
          options.setup === undefined
            ? "core_unavailable"
            : "configuration_setup_required",
          options.setup === undefined
            ? "Core message ingress is not configured"
            : "Configuration must be completed before messages can be processed",
          503,
        );
      }

      return runWithLogContext({}, async () => {
        await runtime.dispatch({
          kind: "web",
          sessionId: parsed.sessionId,
          text: parsed.text,
          requestId: request.id,
        });
        request.log.info(
          { event: "http.message.accepted" },
          "Message accepted by Kaguya Runtime",
        );
        return reply.code(202).send({
          data: {
            status: "accepted",
            requestId: request.id,
          },
        });
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
