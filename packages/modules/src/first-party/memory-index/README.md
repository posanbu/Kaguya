# Memory 向量索引

## 目的与非目标

生成派生向量并回填历史文档，不修改 canonical Memory，不执行事实演化。

## 消费和产生

消费 writeback completed、index requested 与 backfill requested；产生逐文档 request、分页 continuation 和 index completed。

## 数据流与边界

启动时由窄 bootstrap capability 创建回填根；每页最多 50 条，模型完整身份包括 modelId、revision、dimensions。所有正文只从持久化文档读取。

## Settings

模块使用严格空设置。selected Profile 的 `memory.enabled` 控制全局开关；provider 端点与凭据由 composition 持有，不进入模块 settings。

## 可靠性、幂等和失败行为

每个模型身份/source 只有一个 request，pgvector 主键确保重放不重复。页任务先登记文档与 continuation，再提交终态；旧模型任务显式 superseded。失败有界重试，stop 保留 pending。

## 日志与可观测性

request/terminal 可通过 Information Inspection 查看。普通日志只包含稳定状态，不输出正文、向量、模型密钥或远端原始错误。

## 典型场景

修改 embedding revision 后重启，历史文档重新构建向量；新消息同时经 writeback completed 进入索引。
