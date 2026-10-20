/**
 * 功能概述：显式管理音色或合成一次本地试听文件，不向 QQ 发送消息。
 * 主要职责：读取已有 Profile 与 API Key，创建/查询旧版 Qwen-TTS 音色。
 * 代码库关系：共享 Server 配置契约和 llm provider，不修改生产配置。
 * 输入输出与副作用：create/sample 会调用云端；输出仅为音色清单或音频文件。
 */
import { pathToFileURL } from "node:url";
import { open } from "node:fs/promises";
import { FileUserConfigManager } from "@kaguya/config";
import {
  createQwenTtsProvider,
  createQwenVoiceManager,
  TtsError,
} from "@kaguya/llm";
import { readServerBootstrapConfig } from "./config.js";
import { serverTtsSettingsSchema } from "./tts.js";

export async function runTtsCommand(args: readonly string[]): Promise<unknown> {
  const [action, providerId, ...rest] = args;
  if (!providerId || !["list", "create", "sample"].includes(action ?? ""))
    throw new Error(
      "Usage: tts-cli list <provider> [page] | create <provider> <name> <wav> | sample <provider> <text> <output.wav>",
    );
  if (
    (action === "list" && rest.length > 1) ||
    (action !== "list" && rest.length !== 2)
  )
    throw new Error("Invalid TTS command arguments");
  const manager = await FileUserConfigManager.open({
    rootDir: readServerBootstrapConfig().configRoot,
  });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  const provider = profile.ai.providers.find((p) => p.id === providerId);
  if (!provider?.apiKey)
    throw new Error("TTS provider credentials are missing");
  const settings = serverTtsSettingsSchema.parse(provider.settings.tts);
  const identity = {
    provider: "qwen" as const,
    accountScope: settings.accountScope,
    region: settings.region,
    model: settings.model,
    voice: settings.voice,
    language: settings.language,
  };
  if (action === "sample") {
    const client = createQwenTtsProvider({
      identity,
      apiKey: provider.apiKey,
      audioHosts: settings.audioHosts,
      timeoutMs: settings.timeoutMs,
    });
    // Reserve the explicit destination before a paid call, never overwrite a file.
    const output = await open(rest[1]!, "wx", 0o600);
    try {
      const audio = await client.synthesize(
        rest[0]!,
        AbortSignal.timeout(settings.timeoutMs),
      );
      await output.writeFile(audio.bytes);
      return {
        path: rest[1],
        durationMs: audio.durationMs,
        byteLength: audio.bytes.length,
      };
    } finally {
      await output.close();
    }
  }
  const voices = createQwenVoiceManager({ identity, apiKey: provider.apiKey });
  if (action === "list") return voices.list(Number(rest[0] ?? 0));
  const file = await open(rest[1]!, "r");
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > 10 * 1024 * 1024)
      throw new Error("Invalid reference audio size");
    bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error("Reference audio changed");
  } finally {
    await file.close();
  }
  return {
    voice: await voices.create(rest[0]!, bytes),
    model: identity.model,
    region: identity.region,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTtsCommand(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error: unknown) => {
      // Validation/provider failures may contain user input: never print raw errors or credentials.
      process.stderr.write(
        `TTS command failed (${error instanceof TtsError ? error.code : "configuration_or_file_error"}). Check action, Profile settings, region, model, credentials and input/output files. No automatic retry.\n`,
      );
      process.exitCode = 1;
    });
}
