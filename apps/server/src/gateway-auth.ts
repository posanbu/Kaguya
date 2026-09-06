/**
 * 功能概述：统一封装当前进程 Gateway Bearer token 的授权检查。
 * 主要职责：为 setup、management 和 messages 三个权限范围校验同一个启动期 token。
 * 代码库关系：`server.ts` 创建认证器并传给 `app.ts`；本模块不读取环境或磁盘凭据。
 * 输入输出与副作用：只进行常量时间的内存比较，无文件或网络 I/O。
 */
import { timingSafeEqual } from "node:crypto";

export type GatewayScope = "setup" | "management" | "messages";

export interface GatewayAuthenticator {
  authorize(token: string, scope: GatewayScope): Promise<boolean>;
}

export function createGatewayAuthenticator(
  expectedToken: string,
): GatewayAuthenticator {
  return {
    async authorize(token) {
      return safeEqual(token, expectedToken);
    },
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
