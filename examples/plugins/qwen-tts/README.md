# Qwen TTS 输出插件

本包把 Qwen 非实时语音合成封装成独立 Information Module 插件。它只消费已经通过目标授权的正文。插件启用后接管默认文字输出；`mode: text` 保持文字行为，`mode: voice-fallback-text` 只对 `scopeAllowlist` 明确允许的 QQ 会话合成语音。

音频写入 `<KAGUYA_CONFIG_ROOT>/media`。Information Atom 只保存 `sha256:` 资源引用、MIME、字节数、校验和及实际合成文本。Runtime 在发送时读取字节，NapCat 通过 OneBot `record` 段接收，因此 Kaguya 与 NapCat 可以运行在不同机器。Web 不接收音频；插件会直接选择文字分支。

安装方式与普通独立插件相同。先构建 Kaguya，再把同版本 SDK、schema 和本包安装到配置根。

```bash
pnpm --dir "$KAGUYA_CONFIG_ROOT" --ignore-workspace add \
  "link:$KAGUYA_ROOT/packages/sdk" \
  "link:$KAGUYA_ROOT/packages/schema" \
  "file:$KAGUYA_ROOT/examples/plugins/qwen-tts"
```

在 `cordis.yml` 的 `plugins` 中加入：

```yaml
- id: module.qwen-tts.default
  name: "@kaguya-plugin/qwen-tts"
  disabled: false
  definitionId: plugin.qwen-tts
  settings:
    mode: voice-fallback-text
    scopeAllowlist:
      - "qq:napcat.qq.main:private:987654321"
    apiKey: "替换为 DashScope API Key"
    endpoint: "https://dashscope-intl.aliyuncs.com"
    model: qwen3-tts-vc-2026-01-22
    voiceId: "替换为同一账号、区域和模型下的八千代音色 ID"
    language: Chinese
    timeoutMs: 30000
    maxTextLength: 500
    maxAudioBytes: 8388608
```

`scopeAllowlist` 的格式是 `平台:适配器:目标类型:目标 ID`。`*` 会允许所有 QQ 会话，应谨慎使用。代码块、Markdown 表格、URL 或超过上限的正文走文字分支，不会被插件隐式改写。

`provider.mjs` 额外导出 `createVoice()`、`queryVoice()` 和 `deleteVoice()`。音色创建是管理操作，不在每次回复时执行。Qwen3-TTS 音色管理使用 `model: qwen-voice-enrollment`。管理调用与合成必须使用同一 endpoint、账号和 `target_model`。国际区使用 `https://dashscope-intl.aliyuncs.com`；切换北京区时，API Key、endpoint、音色和模型必须一起切换。本包不附带八千代参考音频，也不保证任意默认音色 ID 在部署账号中可用。

## 初始化音色

在配置根安装插件后，可以使用独立 provider 管理音色。以下示例创建音色，再核对所属模型；`audioDataUrl` 使用阿里云可读取的参考音频地址或音频 data URI。API Key 从本机环境读取，不放进命令行参数或事件。

```js
import { QwenTtsProvider } from "@kaguya-plugin/qwen-tts/provider";

const provider = new QwenTtsProvider({
  apiKey: process.env.DASHSCOPE_API_KEY,
  endpoint: "https://dashscope-intl.aliyuncs.com",
});
const targetModel = "qwen3-tts-vc-2026-01-22";
const created = await provider.createVoice({
  model: "qwen-voice-enrollment",
  targetModel,
  name: "yachiyo",
  audioDataUrl: process.env.QWEN_REFERENCE_AUDIO,
});
const voiceId = created.output.voice;
const result = await provider.queryVoice({
  model: "qwen-voice-enrollment",
  targetModel,
  voiceId,
});
if (!result.voice) throw new Error("音色与目标模型不匹配");
console.log(voiceId);
```

把返回的 ID 写入插件 `voiceId`。不再使用的音色可通过 `deleteVoice({ model: "qwen-voice-enrollment", voiceId })` 删除。参考音频要求和模型可用性以[阿里云音色复刻文档](https://www.alibabacloud.com/help/zh/model-studio/voice-cloning-user-guide)为准。创建成功并不代表八千代音质已达标，需要先试听，再验证 QQ 接收。

## 恢复与资源边界

Qwen3-TTS 非流式接口返回 WAV 下载地址。插件在超时和体积限制内下载，校验 RIFF 分块、PCM 格式及 SHA-256 后登记资源。模型、音色、语言、区域和限制随请求冻结，恢复使用这些参数；API Key 始终来自当前秘密设置。远端合成成功、本地产物尚未登记时进程崩溃，供应商可能再次计费。执行事实保留这个不确定阶段，持久订阅最多尝试三次；供应商错误和资源写入失败登记终态后只回退一次文字。

已有完成产物直接复用；在首次创建投递前发现文件缺失或损坏时，记录 `resource-missing` 并回退文字。同一授权正文共用唯一投递槽，恢复不会再创建另一条语音或文字。投递事实已创建后资源才损坏时，Runtime 记录投递失败，不再盲目发送文字，以免平台其实已经接收却重复回复。平台超时同样不能证明 QQ 没有接收。

资源默认在启动时清理七天前的文件，但尚未完成投递或仍在持久重试窗口内的资源会保留。账本中的元数据长期保留，过期资源不能再次播放。文件只由宿主进程读取；POSIX 使用私有目录与文件权限，Windows 继承配置根 ACL。停止模块会取消网络和下载，不接受迟到写入；尚未完成的请求保留给恢复处理。回合已经结束时登记取消，不派生语音或文字。

真实音色效果与 QQ 接收尚需使用部署账号人工验证。本插件没有内置账号凭据、音色 ID 或参考音频，也没有调用付费接口。

## 来源

接口按[Qwen TTS API](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api)和[音色管理 API](https://www.alibabacloud.com/help/en/model-studio/voice-clone-design-http-api)独立实现。Issue 所引用的 [wkf16/yachiyo-qwen-voice-reply](https://github.com/wkf16/yachiyo-qwen-voice-reply)提供了音色管理和回复流程的参考，其 README 声明 MIT。本包未复制上游 Python 脚本、播放逻辑或安装脚本，使用随包附带的 Kaguya MIT 许可。
