# QQ 表情与 Emoji 插件

## 目的与非目标

`plugin.qq-expression` 为 QQ 回复提供独立的表情收藏和低频表达能力。机器人没有视觉能力；素材含义来自同一会话的文字上下文，始终标记为 `context-inference`。普通照片不会自动收藏，未知或低置信度素材不会进入发送候选。收藏是机器人自身的素材库，不是操作 QQ 客户端的“我的收藏”。

支持 Unicode emoji、OneBot `face`、`mface`，以及 NapCat 用 `image` 上报的表情图片（`sub_type=1` 或 `file=marketface`）。数组消息和 CQ 字符串均可接收。协议依据：[NapCat 消息格式](https://napneko.github.io/develop/msg)。

## 消费和产生

插件消费入站消息、消息草稿和自身的学习/选择事实，产生收藏、用法观测、语义推断、选择请求和最终 assistant 消息。它不直接访问平台传输，不改变 Heartflow 的参与决策，也不绕过 Composer 的目标授权和投递链。

## 数据流与边界

适配器保留结构化素材；Runtime 只透传到来源字段。插件按平台、适配器与群/私聊目标隔离收藏，每条入站最多收藏一个素材。图片只接受 HTTPS QQ CDN，并拒绝重定向、非图片和超过 512 KiB 的文件；副本保存到插件账本，不依赖以后仍可访问的临时链接。下载失败跳过收藏，后续再次出现时可以重试。

收藏时冻结最多九条文字来源。模型只读文字和来源 ID，不接收图片字节，不猜测画面。已收藏素材再次出现且距离上次观测至少一分钟时，可以用新语境重新推断；候选使用最新推断，低置信度更新会撤销此前的可用资格。

Planner 在 `composition.tone` 中区分 `neutral`、`humorous`、`teasing`。旧记录缺失字段按 neutral 处理。插件只对当前会话中明确幽默或友好调侃的计划选择表情；跨会话发送的确认正文不添加表情。即使符合语境，模型也可不选，且不能编造素材 ID。

QQ 草稿中的 emoji 会先按完整 Unicode 字素清理，再统一选择至多一个图片、QQ face/mface 或 emoji。只有表情没有文字的草稿被抑制时回退到“嗯。”。非 QQ 平台不进入该处理；关闭插件后恢复原有正文流程。

## Settings

新建生产配置默认包含 `qq-expression.default`；已有部署可通过模块配置启用 `plugin.qq-expression`，无需启用 Memory。设为 `enabled: false` 后重新应用配置即可停用。

```json
{
  "version": 1,
  "instanceId": "qq-expression.default",
  "definitionId": "plugin.qq-expression",
  "enabled": true,
  "settings": {
    "cooldownSeconds": 600,
    "minMessagesBetween": 8,
    "minConfidence": 0.85,
    "maxAssetsPerScope": 100
  }
}
```

`cooldownSeconds` 和 `minMessagesBetween` 必须同时满足。首次使用也需要先有足够的普通回复，避免刚启动就连发表情。计数基于插件已保存的 prepared 输出，失败投递仍占额度，保守抑制错误重试时的连发。`minConfidence` 是模型推断的筛选阈值，不代表经校准的正确率。`maxAssetsPerScope` 限制每个会话的收藏量，达到上限后保留旧素材，并允许已有素材继续学习。

`qq-expression.learn` 与 `qq-expression.select` 模板支持正常的 default/local 覆盖和模板管理。Planner 的 tone 规则位于 `heartflow.planner`；有本地覆盖的部署需同步加入该规则，否则缺失 tone 会保守禁发表情。

## 可靠性、幂等和失败行为

素材按会话和平台素材标识去重，使用观测按素材与来源消息去重。模型任务使用冻结来源及可重放请求，最终 prepared 以草稿 ID 幂等保存，Composer 再登记正式 assistant。插件内部串行提交发送额度，避免同一宿主中的并发草稿同时通过限频；额度来自持久化输出，重启不会清零。

表情选择模型以真实入站作为独立因果来源，冻结草稿与候选仍作为上下文引用，模型失败不会沿正文生成链终止回合。模型失败、无效证据或非法选择都回退到无表情正文；图片下载失败不影响普通回复。素材和推断保存在现有数据库，不另建 Memory 存储。停用不会删除历史收藏。

## 日志与可观测性

模块检查页显示语义、用法与置信度；日志只记录学习结果的置信度，不输出图片字节和下载地址。`core.delivery.delivered` 才表示平台已返回成功，收藏完成、生成 assistant 或登记投递请求均不代表 QQ 已发送。

## 典型场景

群友在“哈哈这次又翻车了”之后发送表情。插件保存素材，并可能推断它适合友好自嘲。以后 Planner 选择同群的幽默话题，且时间和消息间隔都满足时，插件可以选用该素材。严肃求助、语义不明、别的群聊、发送太频繁或模型选择无匹配时，继续发送普通文字。
