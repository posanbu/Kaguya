/** Qwen 非实时 TTS provider。只合成和管理音色，不接触平台发送。 */
const SYNTHESIS_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const CUSTOMIZATION_PATH = "/api/v1/services/audio/tts/customization";

export class QwenTtsProvider {
  constructor(options) {
    this.options = {
      fetch: globalThis.fetch,
      timeoutMs: 30_000,
      maxAudioBytes: 8 * 1024 * 1024,
      ...options,
    };
    const endpoint = new URL(this.options.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new QwenTtsError(
        "provider-rejected",
        "Qwen endpoint must use HTTPS",
      );
  }

  async synthesize(input, signal) {
    const response = await this.#request(
      SYNTHESIS_PATH,
      {
        model: input.model,
        input: {
          text: input.text,
          voice: input.voiceId,
          language_type: input.language,
        },
      },
      signal,
    );
    const rawAudioUrl = response?.output?.audio?.url;
    if (typeof rawAudioUrl !== "string" || !/^https?:\/\//u.test(rawAudioUrl))
      throw new QwenTtsError(
        "invalid-response",
        "Qwen did not return an HTTP audio URL",
      );
    const audioUrl = new URL(rawAudioUrl);
    audioUrl.protocol = "https:";
    const bytes = await this.#fetch(
      audioUrl.href,
      { signal },
      async (download, downloadSignal) => {
        if (!download.ok)
          throw new QwenTtsError(
            "download-failed",
            `Audio download failed (${download.status})`,
          );
        return readBounded(
          download,
          this.options.maxAudioBytes,
          "audio-too-large",
          downloadSignal,
        );
      },
    );
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > this.options.maxAudioBytes ||
      !isExpectedWav(bytes)
    )
      throw new QwenTtsError(
        "invalid-audio",
        "Downloaded audio failed format or size validation",
      );
    return {
      bytes,
      mimeType: "audio/wav",
      requestId: stringOrUndefined(response?.request_id),
      usage: normalizeUsage(response?.usage),
    };
  }

  createVoice(input, signal) {
    return this.#request(
      CUSTOMIZATION_PATH,
      {
        model: input.model,
        input: {
          action: "create",
          target_model: input.targetModel,
          preferred_name: input.name,
          audio: { data: input.audioDataUrl },
        },
      },
      signal,
    );
  }
  async queryVoice(input, signal) {
    for (let page = 0; page < 100; page += 1) {
      const response = await this.#request(
        CUSTOMIZATION_PATH,
        {
          model: input.model,
          input: {
            action: "list",
            page_index: page,
            page_size: 100,
          },
        },
        signal,
      );
      const voice = response?.output?.voice_list?.find(
        (item) =>
          item?.voice === input.voiceId &&
          item?.target_model === input.targetModel,
      );
      if (voice || (response?.output?.voice_list?.length ?? 0) < 100)
        return {
          ...response,
          voice,
        };
    }
    throw new QwenTtsError(
      "voice-list-limit",
      "Voice lookup exceeded the bounded page limit",
    );
  }
  deleteVoice(input, signal) {
    return this.#request(
      CUSTOMIZATION_PATH,
      {
        model: input.model,
        input: {
          action: "delete",
          voice: input.voiceId,
        },
      },
      signal,
    );
  }

  async #request(path, body, signal) {
    return this.#fetch(
      new URL(path, `${this.options.endpoint}/`).href,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
      async (response, responseSignal) => {
        if (!response.ok)
          throw new QwenTtsError(
            classifyStatus(response.status),
            `Qwen request failed (${response.status})`,
          );
        const bytes = await readBounded(
          response,
          1024 * 1024,
          "invalid-response",
          responseSignal,
        );
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new QwenTtsError(
            "invalid-response",
            "Qwen returned invalid JSON",
          );
        }
      },
    );
  }

  async #fetch(url, init, consume) {
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    controller.signal.addEventListener(
      "abort",
      () =>
        rejectAbort(
          new QwenTtsError(
            "timeout-or-cancelled",
            "Qwen request timed out or was cancelled",
          ),
        ),
      { once: true },
    );
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      this.options.timeoutMs,
    );
    const abort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    try {
      if (controller.signal.aborted) return await aborted;
      return await Promise.race([
        aborted,
        this.options
          .fetch(url, { ...init, signal: controller.signal })
          .then((response) => consume(response, controller.signal)),
      ]);
    } catch (error) {
      if (error instanceof QwenTtsError) throw error;
      if (controller.signal.aborted)
        throw new QwenTtsError(
          "timeout-or-cancelled",
          "Qwen request timed out or was cancelled",
        );
      throw new QwenTtsError("network", "Qwen request failed", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }
}

async function readBounded(response, limit, code, signal) {
  if (Number(response.headers.get("content-length") ?? "0") > limit)
    throw new QwenTtsError(code, "Response exceeds the configured size limit");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit)
        throw new QwenTtsError(
          code,
          "Response exceeds the configured size limit",
        );
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class QwenTtsError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "QwenTtsError";
    this.code = code;
  }
}
function classifyStatus(status) {
  return status === 401 || status === 403
    ? "unauthorized"
    : status === 404
      ? "voice-not-found"
      : status === 408 || status === 429 || status >= 500
        ? "retryable-provider"
        : "provider-rejected";
}
function stringOrUndefined(value) {
  return typeof value === "string" && value ? value : undefined;
}
function isExpectedWav(bytes) {
  if (
    bytes.length < 44 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE"
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 44) return false;
  let blockAlign = 0;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= end;) {
    const kind = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > end) return false;
    if (kind === "fmt ") {
      if (length < 16) return false;
      const encoding = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const bits = view.getUint16(start + 14, true);
      blockAlign = view.getUint16(start + 12, true);
      if (
        ![1, 3].includes(encoding) ||
        (encoding === 3 && bits !== 32) ||
        channels < 1 ||
        channels > 2 ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        ![8, 16, 24, 32].includes(bits) ||
        blockAlign !== (channels * bits) / 8 ||
        view.getUint32(start + 8, true) !== sampleRate * blockAlign
      )
        return false;
    } else if (kind === "data") dataLength += length;
    offset = start + length + (length % 2);
  }
  return blockAlign > 0 && dataLength > 0 && dataLength % blockAlign === 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const normalized = Object.fromEntries(
    [
      ["inputTokens", nonnegativeInteger(usage.input_tokens)],
      ["outputTokens", nonnegativeInteger(usage.output_tokens)],
      ["totalTokens", nonnegativeInteger(usage.total_tokens)],
      ["characters", nonnegativeInteger(usage.characters)],
    ].filter((entry) => entry[1] !== undefined),
  );
  return Object.keys(normalized).length ? normalized : undefined;
}
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
