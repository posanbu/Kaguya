/**
 * 功能概述：为已授权入站消息提供限额 HTTPS 图片下载，由 media-composition 注入 Runtime。
 * 主要职责：createMediaDownloader 校验精确主机允许列表，使用独立可取消 Resolver 查询公网
 * IPv4，并将已检查地址固定给 TLS 请求；isPublicMediaAddress 拒绝特殊用途及私有地址。
 * 输入输出与副作用：仅消费 source.url，返回最多 10 MiB 的原始字节，不跟随重定向、不解压。
 * DNS 与响应共享五秒预算；取消、超时和失败销毁本次连接并取消本次解析，迟到结果不能发起请求。
 * 代码库关系：MediaInputOptions.acquire 消费字节后负责图片解码；错误只含固定代码，不含 URL、
 * DNS 错误或调用方的取消原因。每次独立 Resolver 避免一个下载取消其他在途任务。
 */
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { MediaInputOptions } from "@kaguya/runtime";

const maxBytes = 10 * 1024 * 1024;
const timeoutMs = 5_000;

export function isPublicMediaAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function createMediaDownloader(
  allowedHosts: readonly string[],
): NonNullable<MediaInputOptions["acquire"]> {
  const approved = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return async (segment, _input, signal) => {
    const raw = segment.source.url;
    if (!raw || raw.length > 8192) return undefined;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !approved.has(url.hostname.toLowerCase())
    )
      return undefined;
    if (signal.aborted) throw new Error("media-download-aborted");

    return new Promise<Uint8Array>((resolve, reject) => {
      let resolver: Resolver | undefined;
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      const timer = setTimeout(
        () => finish("media-download-timeout"),
        timeoutMs,
      );
      const aborted = () => finish("media-download-aborted");
      function finish(code?: string, bytes?: Uint8Array): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        resolver?.cancel();
        if (code) {
          response?.destroy();
          req?.destroy();
          reject(new Error(code));
        } else {
          resolve(bytes!);
        }
      }
      signal.addEventListener("abort", aborted, { once: true });
      const download = async () => {
        resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
        const literalFamily = isIP(url.hostname);
        const addresses =
          literalFamily === 4
            ? [url.hostname]
            : url.hostname.startsWith("[")
              ? []
              : await resolver.resolve4(url.hostname);
        if (settled) return;
        if (
          !addresses.length ||
          addresses.some((address) => !isPublicMediaAddress(address))
        ) {
          finish("media-download-address-denied");
          return;
        }
        const address = addresses[0]!;
        req = request(
          url,
          {
            method: "GET",
            agent: false,
            headers: {
              Accept: "image/png,image/jpeg,image/gif,image/webp",
              "Accept-Encoding": "identity",
            },
            // Preserve the URL hostname for TLS/SNI and Host; never perform a second DNS query.
            lookup: (_host, options, done) => {
              if (options.all) done(null, [{ address, family: 4 }]);
              else done(null, address, 4);
            },
          },
          (res) => {
            if (settled) {
              res.destroy();
              return;
            }
            response = res;
            res.on("error", () => finish("media-download-failed"));
            res.on("aborted", () => finish("media-download-failed"));
            res.on("close", () => {
              if (!res.complete) finish("media-download-failed");
            });
            const length = res.headers["content-length"];
            const expected = length === undefined ? undefined : Number(length);
            if (
              res.statusCode !== 200 ||
              (res.headers["content-encoding"] &&
                res.headers["content-encoding"] !== "identity") ||
              (length !== undefined &&
                (!/^\d+$/u.test(length) ||
                  !Number.isSafeInteger(expected) ||
                  expected! > maxBytes))
            ) {
              finish("media-download-failed");
              return;
            }
            let total = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > maxBytes) finish("media-download-failed");
              else chunks.push(chunk);
            });
            res.on("end", () => {
              if (
                !res.complete ||
                (expected !== undefined && expected !== total)
              )
                finish("media-download-failed");
              else if (!total) finish("media-download-empty");
              else finish(undefined, Buffer.concat(chunks));
            });
          },
        );
        req.on("error", () => finish("media-download-failed"));
        req.end();
      };
      void download().catch(() => finish("media-download-failed"));
    });
  };
}
