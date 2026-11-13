/** 在评测私有输出中保留每次实际模型尝试，包括随后被结构恢复替代的输出。 */
export function captureModelAttempts(resolveModel, attempts) {
  const cache = new WeakMap();
  return (selection) => {
    const resolved = resolveModel(selection);
    let model = cache.get(resolved.model);
    if (!model) {
      const original = resolved.model;
      model = new Proxy(original, {
        get(target, key) {
          if (key === "doGenerate")
            return async (request) => {
              const attempt = {
                index: attempts.length + 1,
                startedAt: new Date().toISOString(),
                modelId: resolved.modelId,
                status: "started",
              };
              attempts.push(attempt);
              try {
                const result = await target.doGenerate(request);
                Object.assign(attempt, {
                  status: "returned",
                  endedAt: new Date().toISOString(),
                  content: result.content,
                  usage: result.usage,
                  finishReason: result.finishReason,
                });
                return result;
              } catch (error) {
                Object.assign(attempt, {
                  status: "failed",
                  endedAt: new Date().toISOString(),
                });
                // 完整错误由生产 Model Task 脱敏。评测不复制 SDK 请求、响应头或凭据。
                throw error;
              }
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      cache.set(original, model);
    }
    return { ...resolved, model };
  };
}
