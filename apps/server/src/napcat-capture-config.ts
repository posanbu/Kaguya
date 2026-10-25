/**
 * 功能概述：校验独立于机器人入站和发送权限的 NapCat 群聊采集配置。
 * 主要职责：readCaptureSettings 保留显式设置，缺省返回空对象；启用时要求固定登录账号和非空群范围。
 * 代码库关系：NapCat 配置读取、管理 API 与采集服务共同使用本契约；不创建目录或连接。
 * 输入输出与副作用：纯值校验，错误仅含固定提示；群和账号使用稳定数字字符串，不按昵称识别。
 */
export interface NapCatCaptureSettings {
  readonly captureEnabled?: boolean;
  readonly captureGroups?: string[];
  readonly captureQueueLimit?: number;
}

export function readCaptureSettings(
  value: Record<string, unknown>,
): NapCatCaptureSettings {
  const { captureEnabled, captureGroups, captureQueueLimit } = value;
  if (captureEnabled !== undefined && typeof captureEnabled !== "boolean")
    throw new Error("Invalid capture switch");
  if (
    captureGroups !== undefined &&
    (!Array.isArray(captureGroups) ||
      captureGroups.length > 100 ||
      captureGroups.some(
        (id) => typeof id !== "string" || !/^[1-9][0-9]*$/u.test(id),
      ) ||
      new Set(captureGroups).size !== captureGroups.length)
  )
    throw new Error("Invalid capture groups");
  if (
    captureQueueLimit !== undefined &&
    (typeof captureQueueLimit !== "number" ||
      !Number.isInteger(captureQueueLimit) ||
      captureQueueLimit < 1 ||
      captureQueueLimit > 10000)
  )
    throw new Error("Invalid capture queue limit");
  if (
    captureEnabled &&
    (typeof value.selfId !== "string" ||
      !/^[1-9][0-9]*$/u.test(value.selfId) ||
      !Array.isArray(captureGroups) ||
      !captureGroups.length)
  )
    throw new Error(
      "Capture requires a fixed login identity and explicit groups",
    );
  return {
    ...(captureEnabled === undefined
      ? {}
      : { captureEnabled: captureEnabled as boolean }),
    ...(captureGroups === undefined
      ? {}
      : { captureGroups: [...(captureGroups as string[])] }),
    ...(captureQueueLimit === undefined
      ? {}
      : { captureQueueLimit: captureQueueLimit as number }),
  };
}
