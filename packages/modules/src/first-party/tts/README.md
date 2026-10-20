# TTS 首版接入状态

## 目的与非目标

已实现可选第一方模块 `agent.tts`、持久化阶段、Heavy 唯一出口和音频投递契约。
默认关闭；只有显式注入 `MessageCompositionOptions.tts: TtsHost` 才装配模块、能力及实例。
Server 从选中 Profile 的 provider settings.tts 显式装配；密钥复用 provider.apiKey。
安装声明始终保留，关闭后可读取历史记录，但没有运行实例。

## 数据流与边界

Heavy 完成授权检查并确认普通当前会话意图后调用宿主 `plan`。只有宿主确认该会话明确启用
且实际 transport 支持音频才返回计划。跨会话授权意图和正文确认分支始终保留文字。
超长、代码、表格、URL 等内容保持原文，不清洗。文字/语音共用原 Heavy 出口唯一槽，
所以设置改变或订阅重放不会新增另一种投递。

## 消费和产生

语音分支是 `agent.tts.requested → agent.tts.started → agent.tts.result → core.delivery.requested`。
模块消费 requested/result，产生 started/result/delivery.requested/delivery.cancelled。

## 可靠性、幂等和失败行为

结果使用 completed/failed/cancelled 三种状态，共用 `kaguya.tts.result.v1` 终态槽。
重放先查终态，再查任务产物；已有产物复用，不再次合成。执行标记已存在而产物未保存时，
记为 `outcome_unknown` 并回退文字，不尝试消除供应商可能已计费的未知窗口。

结果释放时再次检查宿主授权/取消状态和有效期。取消或过期写入
`agent.tts.delivery.cancelled`，Router 据此闭合回合，不产生平台发送。
音频文件丢失时投递原文，原因写入 `ttsFallbackReason`。
取消和投递共用同一操作槽；不会出现迟到音频与文字回退各发送一次。
平台实际发送失败仍由 Runtime 记为投递失败，不盲目再次发送或声称成功。

## Settings

模块 settings 当前为严格空对象。实际按会话启用、长度上限和冻结音色由宿主能力提供，
未注入能力时没有模块实例。凭据不属于模块 settings，不能写入可展示配置。

## 宿主与文件

`TtsHost` 提供 `plan/isCurrent/synthesize/find/save/exists`。`plan` 不能接受客户端自报的
授权或音频支持标志，`isCurrent` 必须依据宿主的当前会话/回合/取消状态复核。
合成实现必须使用请求冻结的账号、地域、模型、音色和语言；凭据不进入请求原子。

`@kaguya/runtime` 导出 `TtsAudioStore.open(root)`，提供内容寻址的 WAV 和任务索引文件。
使用独占临时文件和硬链接发布，进程恢复可复用；读取核验类型、大小、SHA-256，
拒绝任意路径和符号链接。目录仅限服务身份访问；Windows 需部署方设置 NTFS ACL。
总线仅保存摘要、大小、时长及正文，不保存二进制/base64。默认配额 512 MiB/10,000 文件，
最近访问后保留 24 小时，打开/规划/保存时清理，满额拒绝新产物而不驱逐有效音频。
目录仅供单个服务进程使用；历史仍保留语音标记和正文，不提供 Web 音频回放。

NapCat 的 `resolveAudio` 回调应绑定 `store.bytes`，只有此回调存在才可声明支持语音。
它验证内容摘要并在发送边界编码 OneBot `record` 的 base64 文件参数，避免依赖共享路径。
基础 OneBot builder 无解析器时拒绝音频，Web transport 拒绝音频成功回执。
WAV 的实际 NapCat 兼容性仍需在部署环境验证，不把模拟回执当作真实投递或试听结果。

## 日志与可观测性

生命周期日志只投影事件名和结果状态，不记录音频字节、密钥、签名 URL 或原始 provider 错误。
失败回退原因位于投递载荷 `ttsFallbackReason`，可沿原子引用检查原正文、合成结果和平台回执。
通用模块检查页展示等待/执行/结果/取消及处理耗时、输入字符数；输入字符数不是账单用量。

## 典型场景

正常短回复生成音频引用并等待平台回执；失败或未知执行结果只回退一次原文；
取消或过期只闭合回合，不发送迟到语音。

## 已验证与剩余工作

真实 PGlite/Core/ModuleHost/Runtime 集成覆盖正文、请求、结果、投递回执及回合终态。
隔离测试覆盖重放、保存后崩溃恢复、未知结果、失败回退、取消、资源缺失、文件完整性、
QQ 消息段与 Web 不支持音频的行为。

部署配置、音色管理命令与试听步骤见 [QQ 语音回复](../../../../../docs/guide/tts.md)。
真实 Qwen 音色合成/人工试听/QQ 接收仍待部署验收。底层客户端见 [@kaguya/llm](../../../../llm/README.md)。
