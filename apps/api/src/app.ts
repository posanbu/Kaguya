import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  OpenAiCompatibleError,
  OpenAiCompatibleLlmService,
  type OpenAiCompatibleRequest,
  type OpenAiCompatibleResult,
} from "@kaguya/llm";
import { z } from "@kaguya/schema";
import Fastify, {
  type FastifyReply,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

import type { ApiGatewayConfig } from "./config.js";

const apiKeyHeaderSchema = z.enum(["Authorization", "api-key", "x-api-key"]);
const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const chatRequestSchema = z
  .object({
    apiKey: apiKeySchema,
    baseUrl: z.url().max(2_048).optional(),
    model: z.string().trim().min(1).max(256),
    systemPrompt: z.string().trim().min(1).max(32_768),
    userPrompt: z.string().trim().min(1).max(131_072),
    temperature: z.number().min(0).max(2).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    retryDelayMs: z.number().int().min(0).max(60_000).optional(),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
    apiKeyHeader: apiKeyHeaderSchema.optional(),
  })
  .strict();

const chatBodyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["apiKey", "model", "systemPrompt", "userPrompt"],
  properties: {
    apiKey: {
      type: "string",
      minLength: 1,
      maxLength: 8_192,
      pattern: "^[^\\u0000-\\u001F\\u007F]+$",
    },
    baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
    model: { type: "string", minLength: 1, maxLength: 256 },
    systemPrompt: { type: "string", minLength: 1, maxLength: 32_768 },
    userPrompt: { type: "string", minLength: 1, maxLength: 131_072 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    maxRetries: { type: "integer", minimum: 0, maximum: 10 },
    retryDelayMs: { type: "integer", minimum: 0, maximum: 60_000 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
    apiKeyHeader: {
      type: "string",
      enum: ["Authorization", "api-key", "x-api-key"],
    },
  },
} as const;

export interface ApiGatewayLlmService {
  call(request: OpenAiCompatibleRequest): Promise<OpenAiCompatibleResult>;
}

export interface CreateApiGatewayOptions {
  config: ApiGatewayConfig;
  llmService?: ApiGatewayLlmService;
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
  const llmService = options.llmService ?? new OpenAiCompatibleLlmService();

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
    "/api/v1/llm/chat",
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
        tags: ["LLM"],
        summary: "Call an OpenAI-compatible chat model",
        security: [{ bearerAuth: [] }],
        body: chatBodyJsonSchema,
      },
    },
    async (request, reply) => {
      const parsed = chatRequestSchema.parse(request.body);
      assertAllowedProvider(
        parsed.baseUrl,
        options.config.llmAllowedHosts,
        options.config.allowInsecureLlmHttp,
      );

      const cancellation = requestCancellation(
        request,
        reply,
        options.config.llmRequestTimeoutMs,
      );
      try {
        const result = await llmService.call({
          apiKey: parsed.apiKey,
          model: parsed.model,
          systemPrompt: parsed.systemPrompt,
          userPrompt: parsed.userPrompt,
          signal: cancellation.signal,
          ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
          ...(parsed.temperature === undefined
            ? {}
            : { temperature: parsed.temperature }),
          ...(parsed.maxRetries === undefined
            ? {}
            : { maxRetries: parsed.maxRetries }),
          ...(parsed.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: parsed.retryDelayMs }),
          ...(parsed.timeoutMs === undefined
            ? {}
            : { timeoutMs: parsed.timeoutMs }),
          ...(parsed.apiKeyHeader === undefined
            ? {}
            : { apiKeyHeader: parsed.apiKeyHeader }),
        });
        return reply.code(200).send({ data: result });
      } finally {
        cancellation.dispose();
      }
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
    if (error instanceof OpenAiCompatibleError) {
      request.log.warn(
        {
          errorKind: error.kind,
          providerStatus: error.status,
          attempts: error.attempts,
        },
        "LLM provider call failed",
      );
      return reply.code(providerErrorStatus(error)).send({
        error: {
          code: "llm_provider_error",
          message: publicProviderErrorMessage(error),
          requestId: request.id,
          kind: error.kind,
          attempts: error.attempts,
          ...(error.status === undefined
            ? {}
            : { providerStatus: error.status }),
        },
      });
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

function assertAllowedProvider(
  baseUrl: string | undefined,
  allowedHosts: ReadonlySet<string>,
  allowInsecureHttp: boolean,
): void {
  const url = new URL(baseUrl ?? "https://api.openai.com/v1");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiGatewayError(
      "provider_url_rejected",
      "Provider URLs must use HTTP or HTTPS",
      400,
    );
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new ApiGatewayError(
      "provider_url_rejected",
      "Provider URLs must use HTTPS unless insecure HTTP is explicitly enabled",
      400,
    );
  }
  if (url.username || url.password) {
    throw new ApiGatewayError(
      "provider_url_rejected",
      "Provider URLs cannot contain embedded credentials",
      400,
    );
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ApiGatewayError(
      "provider_not_allowed",
      "The requested provider host is not allowed",
      403,
    );
  }
}

function providerErrorStatus(error: OpenAiCompatibleError): number {
  if (error.kind === "configuration") {
    return 400;
  }
  if (error.kind === "cancelled") {
    return 408;
  }
  if (error.kind === "retryable") {
    return 503;
  }
  return 502;
}

function publicProviderErrorMessage(error: OpenAiCompatibleError): string {
  if (error.kind === "configuration") {
    return "LLM provider configuration is invalid";
  }
  if (error.kind === "cancelled") {
    return "LLM provider call was cancelled";
  }
  if (error.kind === "retryable") {
    return "LLM provider is temporarily unavailable";
  }
  return "LLM provider rejected the request";
}

function requestCancellation(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("API request cancelled"));
  const abortOnResponseClose = () => {
    if (!reply.raw.writableEnded) {
      abort();
    }
  };
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abortOnResponseClose);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      request.raw.off("aborted", abort);
      reply.raw.off("close", abortOnResponseClose);
    },
  };
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
