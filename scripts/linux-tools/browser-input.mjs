/**
 * 功能概述：为一次有期限的浏览器操作建立输入门，保留每条已发送 CDP 输入的真实响应。
 * 主要职责：准备阶段可等待 DOM，send 前同步重验许可；isolate 先封门，再排空真实响应。
 * 代码库关系：Chromium owner 保留页面；此门不关闭页面、不重试命令，也不把客户端取消
 * 或 promise timeout 当作浏览器已完成的证明。实际协议命令由 browser component 固定选择。
 * 输入输出与副作用：只包装受信 send 回调；失败响应使隔离拒绝 ACK，等待点可由测试显式释放。
 */
export class BrowserInputGate {
  constructor({ now = Date.now, allowed = () => true } = {}) {
    this.now = now;
    this.allowed = allowed;
    this.epoch = 0;
    this.pending = new Set();
    this.failed = false;
  }

  permit(expiresAt) {
    const deadline = Date.parse(expiresAt);
    const epoch = this.epoch;
    if (!Number.isFinite(deadline)) throw new Error("invalid-browser-permit");
    const check = () => {
      if (epoch !== this.epoch || !this.allowed() || this.now() >= deadline)
        throw new Error("browser-input-fenced");
    };
    check();
    return {
      check,
      send: (send) => {
        // check 与 send 之间没有 await；隔离不能在此间隙接受旧输入。
        check();
        let raw;
        try {
          raw = send();
        } catch (error) {
          this.failed = true;
          throw error;
        }
        const receipt = Promise.resolve(raw).then(
          (value) => ({ ok: true, value }),
          (error) => {
            this.failed = true;
            return { ok: false, error };
          },
        );
        this.pending.add(receipt);
        void receipt.then(() => this.pending.delete(receipt));
        return receipt.then((result) => {
          if (!result.ok) throw result.error;
          return result.value;
        });
      },
    };
  }

  async isolate() {
    // 同步改变 epoch，使仍在 DOM 准备阶段的旧 token 永久失效。
    this.epoch++;
    const receipts = [...this.pending];
    await Promise.all(receipts);
    if (this.failed) throw new Error("browser-input-drain-unconfirmed");
    return true;
  }
}
