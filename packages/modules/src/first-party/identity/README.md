# Identity

## 目的与非目标

把平台发送者和聊天范围正规化为稳定身份事实；不实现认证、权限或回复策略。

## 消费和产生

消费入站文本，产生聊天范围、平台账号、人物解析及人物上下文原子。

## 数据流与边界

平台 ID 保持为外部事实。首版按 platform、adapter 与精确账号建立 account/person，按 destination 建立独立 scope。同账号跨群聊和私聊复用人物，昵称和群名片只作观察。

匿名 Web 输入返回 unresolved，不创建长期 account/person。同 conversationId 只复用 ephemeral scope；不同会话、adapter 及无 conversationId 的请求隔离。

## Settings

当前使用严格空设置。

## 可靠性、幂等和失败行为

成功处理的同一入站只提交一个身份终态。registerOnce 保留实体和绑定的唯一赢家，commitTerminal 保留终态；重投和重启复用这些持久事实。基础设施错误交由 durable handler 重试和耗尽记录处理。

Memory 的 identity-split 撤销旧人物作为记忆证据的可信性，收集、发布与读路径消费失效事实；它不替账号选择新人物。首版不提供人工重绑定或跨平台合并。

## 日志与可观测性

记录范围和人物解析状态，不输出平台凭据。

## 典型场景

Router 在冻结 turn context 前等待每条入站的身份终态。
