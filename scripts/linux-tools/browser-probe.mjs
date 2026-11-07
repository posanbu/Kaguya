/**
 * 功能概述：读取实际生产 owner 的 sandbox 回执，避免探针额外启动 Chromium 超出任务预算。
 * 代码库关系：默认策略负例单独建立相同 owner；候选策略读取 init 已就绪的同一实例。
 * 输入输出与副作用：仅固定 health JSON；独立负例 owner 在 finally 关闭，不弱化 sandbox。
 */
import { connect } from "node:net";
import { BrowserComponent } from "./browser.mjs";
import { ToolService } from "./service.mjs";
let health;
if (process.env.KAGUYA_BROWSER_ENABLED === "1") {
  const socket = connect(
    process.env.KAGUYA_CONTROL_SOCKET ??
      `${process.env.HOME}/kaguya-tools.sock`,
  );
  let data = "";
  health = await new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    socket.end(
      JSON.stringify({ helperProtocolVersion: 1, kind: "health" }) + "\n",
    );
  });
} else {
  const component = new BrowserComponent();
  const service = new ToolService({ components: [component] });
  try {
    await service.ready();
    health = await service.handle({ helperProtocolVersion: 1, kind: "health" });
  } finally {
    await component.close();
  }
}
if (!health.ready) throw new Error("owner-not-ready");
const browser = health.executors.find(
  (executor) => executor.kind === "chromium",
);
if (
  !browser?.sandbox ||
  !/You are adequately sandboxed\./.test(browser.sandbox)
)
  throw new Error("owner-sandbox-unconfirmed");
console.log(JSON.stringify(browser));
