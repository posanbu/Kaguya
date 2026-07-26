import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { z } from "@kaguya/schema";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

import type { ApiGatewayConfig } from "./config.js";

const messageRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    text: z
      .string()
      .min(1)
      .max(131_072)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

const messageBodyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "text"],
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 256 },
    text: { type: "string", minLength: 1, maxLength: 131_072 },
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

export interface MessageIngressCommand {
  readonly sessionId: string;
  readonly text: string;
  readonly requestId: string;
}

export interface MessageIngress {
  enqueue(command: MessageIngressCommand): Promise<void>;
}

export interface CreateApiGatewayOptions {
  config: ApiGatewayConfig;
  messageIngress?: MessageIngress;
  logger?: FastifyServerOptions["logger"];
}

export async function createApiGateway(
  options: CreateApiGatewayOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    requestIdHeader: "x-request-id",
    trustProxy: options.config.trustProxy,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
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
        summary: "Validate and hand off a message to the core",
        security: [{ bearerAuth: [] }],
        body: messageBodyJsonSchema,
        response: {
          202: acceptedMessageResponseJsonSchema,
          400: errorResponseJsonSchema,
          401: errorResponseJsonSchema,
          429: errorResponseJsonSchema,
          500: errorResponseJsonSchema,
          503: errorResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = messageRequestSchema.parse(request.body);
      if (options.messageIngress === undefined) {
        throw new ApiGatewayError(
          "core_unavailable",
          "Core message ingress is not configured",
          503,
        );
      }

      await options.messageIngress.enqueue({
        sessionId: parsed.sessionId,
        text: parsed.text,
        requestId: request.id,
      });
      return reply.code(202).send({
        data: {
          status: "accepted",
          requestId: request.id,
        },
      });
    },
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (isValidationError(error) || error instanceof z.ZodError) {
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

    request.log.error({ err: error }, "Unhandled API gateway error");
    return reply
      .code(500)
      .send(errorBody("internal_error", "Internal server error", request.id));
  });

  return app;
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

function isHttpError(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}
