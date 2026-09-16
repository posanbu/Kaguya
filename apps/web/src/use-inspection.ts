/**
 * 功能概述：检查页面共用的可取消 GET 状态，加载新查询时不显示旧数据。
 * useInspection 按 token、路径与刷新版本隔离结果，卸载后取消；认证和 DTO 校验由 api.ts 负责。
 * 不轮询、不保存 Token；错误作为安全接口消息返回给调用组件。
 */
import { useEffect, useState } from "react";
import { getInspection } from "./api.js";
export function useInspection<T>(
  token: string,
  path: string | undefined,
  schema: { parse(value: unknown): T },
  revision: number,
) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(
    { key: "" },
  );
  const key = `${path}:${revision}:${token}`;
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    void getInspection({ token }, path, schema, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error: error instanceof Error ? error.message : "读取失败",
          });
      },
    );
    return () => controller.abort();
  }, [token, path, schema, revision, key]);
  return state.key === key ? state : { key };
}
