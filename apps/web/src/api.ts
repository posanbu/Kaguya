export const MAX_MESSAGE_LENGTH = 131_072;

export interface GatewayConfig {
  readonly token: string;
}

export interface SendMessageInput {
  readonly sessionId: string;
  readonly text: string;
}

export interface AcceptedMessage {
  readonly status: "accepted";
  readonly requestId: string;
}

export async function checkGatewayHealth(
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation("/healthz", {
      method: "GET",
    });
  } catch {
    throw new GatewayRequestError("无法连接到 Kaguya 服务", "network_error", 0);
  }

  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload) || payload.status !== "ok") {
    throw new GatewayRequestError(
      `服务健康检查失败（HTTP ${response.status}）`,
      "health_check_failed",
      response.status,
    );
  }
}

interface AcceptedMessageResponse {
  data: AcceptedMessage;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

export async function sendMessage(
  config: GatewayConfig,
  input: SendMessageInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<AcceptedMessage> {
  const token = config.token.trim();
  const sessionId = input.sessionId.trim();

  if (!token) {
    throw new GatewayRequestError("请输入服务访问令牌", "missing_token", 0);
  }
  if (!sessionId) {
    throw new GatewayRequestError("请输入会话 ID", "missing_session_id", 0);
  }
  if (!input.text.trim()) {
    throw new GatewayRequestError("消息不能为空", "empty_message", 0);
  }
  if ([...input.text].length > MAX_MESSAGE_LENGTH) {
    throw new GatewayRequestError(
      "消息超过服务允许的长度",
      "message_too_long",
      0,
    );
  }

  let response: Response;
  try {
    response = await fetchImplementation("/api/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, text: input.text }),
    });
  } catch (error) {
    throw new GatewayRequestError(
      error instanceof Error && error.name === "AbortError"
        ? "服务请求已取消"
        : "无法连接到 Kaguya 服务",
      "network_error",
      0,
    );
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const gatewayError = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      gatewayError?.message ?? `服务请求失败（HTTP ${response.status}）`,
      gatewayError?.code ?? "gateway_error",
      response.status,
      gatewayError?.requestId,
    );
  }
  if (!isAcceptedMessageResponse(payload)) {
    throw new GatewayRequestError(
      "服务返回了无法识别的响应",
      "invalid_response",
      response.status,
    );
  }
  return payload.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isAcceptedMessageResponse(
  value: unknown,
): value is AcceptedMessageResponse {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }
  return (
    value.data.status === "accepted" && typeof value.data.requestId === "string"
  );
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }
  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.requestId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
