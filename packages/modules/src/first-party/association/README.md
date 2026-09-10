# Association

## 目的与非目标

为已进入回复链的上下文召回可审计的相关信息；不决定注意、回复或记忆写入。

## 消费和产生

消费回复请求及关联阶段原子，产生 requested、query、candidate 和 completed 事实。

## 数据流与边界

只通过声明式 Selector 和 Memory retrieval capability 读取账本事实，结果以引用保留来源。

## Settings

当前使用严格空设置。

## 可靠性、幂等和失败行为

各阶段使用稳定 operation key；可选召回失败不会破坏在线回合。

## 日志与可观测性

记录关联阶段终态和候选数量，不记录敏感正文。

## 典型场景

回复前根据当前冻结消息召回相关 Memory 信息。
