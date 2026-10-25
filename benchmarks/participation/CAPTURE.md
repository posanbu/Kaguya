# NapCat 群聊采集与冻结导出

采集器复用 Kaguya 已有 NapCat WebSocket，在入站过滤之前观察群事件。默认关闭；启用须指定登录账号与群。采集数据写入独立私有 journal，既有入站/发送权限、生产 Memory 与模型调用路径保持各自的配置职责。

事件依据 [NapCat OneBot 事件说明](https://napneko.github.io/onebot/event)：接收群 `message`、自身 `message_sent` 和 `notice.group_recall`，使用 `meta_event` 生命周期与健康心跳确认身份和连接状态。文本、@、引用、媒体类型及每条消息自带的显示名保留在私有 journal；图片/语音内容、资源 URL、原始 frame、access token 与 action 响应不写入其中。

## 配置与启动

在现有 `adapter.napcat.main` 实例的 `settings` 中显式增加采集字段：

```json
{
  "wsUrl": "ws://127.0.0.1:3001",
  "selfId": "10001",
  "reconnectMs": 3000,
  "captureEnabled": true,
  "captureGroups": ["20001"],
  "captureQueueLimit": 1000
}
```

这些数字是示例。`captureEnabled` 缺省关闭，`captureGroups` 最多 100 个唯一的群 ID，`captureQueueLimit` 为 1–10000，缺省 1000。账号及群 ID 使用稳定数字字符串。NapCat 平台插件本身需要启用；采集配置使用现有重启生效流程，不因保存配置而连接或启动推理。

管理 API 的 `PUT /api/v1/napcat` 接受同名字段，沿用 management Token、revision 并发检查和重启要求。旧客户端省略采集字段时保留当前采集配置；关闭请显式传 `captureEnabled:false`。API 返回配置状态和脱敏 token 存在标记。

只采集的群须保持在现有入站白名单之外；发送权限仍由出站白名单控制。采集字段本身不会修改这些白名单或触发额外模型请求。先确定实际账号、群范围及采集权限，再使用既有服务启动入口运行。本次程序交付使用虚构事件验收。

## 文件、覆盖与恢复

文件位于 `<configRoot>/capture/<adapterId>/<selfId>/`，其中：

| 文件              | 内容                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `events.jsonl`    | message、recall、coverage 的追加 journal，直接兼容离线 v1 协议    |
| `checkpoint.json` | 最近 fsync 成功并原子提交的字节水位、接收序号、前缀哈希和诊断计数 |
| `locks/`          | 唯一 owner 文件，阻止两个进程写同一 journal                       |

目录和文件在 POSIX 创建为 0700/0600。Windows 使用运行账户的 ACL。一个登录账号一个 journal；更换账号使用不同目录。写入串行进行，socket 回调只向有界队列提交，采集启动失败或写盘失败只报告 `napcat.capture.failed / capture_io_failed`，不阻断原有消息链。

接收序号跨重启恢复，`recordId` 与序号绑定。发生时间优先采用平台秒时间，缺失时明确标为接收时间回退；接收时间采用毫秒墙钟并保持不回退，同时间戳用序号排序。回退被计数并形成 gap。每个记录保留连接代次。

完整覆盖要求身份已核对、连接健康、队列未丢失且写入成功。每 30 秒提交覆盖，超过 60 秒没有可信群消息或健康心跳时转为 gap。`online=false`、`good!=true` 或生命周期 `disable` 也形成 gap。断线、进程重启、未知事件、非法 JSON、重复 ID 内容冲突及队列溢出均会停止连续覆盖，恢复时写出缺口。

缺口起点保守地回到最近覆盖端点前 1 毫秒，避免同毫秒的丢失事件被误判为完整观察。停止时先关闭接收，再排空写入；初始化尚未完成时停止也会等待资源就绪后释放。I/O 失败后停止追加完整覆盖，后续由原有服务启动入口恢复。

恢复时读取完整行并校验已有检查点前缀；未完成的最后一行可截去，已提交内容或完整行损坏时停止采集并报告错误。同群平台消息 ID 及内容指纹用于去重，自身发送事件与重连重报只产生一次参与事件；生成或发送 action 成功回执不会被合成为群聊发言。

同机已死亡 owner 的锁会自动回收；活跃 owner、异机 owner 或损坏锁保持拒绝双写。异机迁移或异常锁需先确认所有 writer 已停止，再人工检查锁目录。正式冻结导出只读取已提交字节前缀，尾部正在写入的数据不会混入本次来源。

## 冻结导出与离线验证

先构建工作区。准备至少 32 字节、受控保存的身份 HMAC 密钥文件；同一 corpus 系列沿用该密钥，不将它写入命令参数、Git 或导出文件。

```bash
pnpm exec tsc -b

pnpm capture:export \
  --journal-dir /private/config/capture/napcat.qq.main/10001 \
  --identity-key-file /private/keys/participation.key \
  --output .data/participation-capture/frozen
```

导出可在采集运行期间执行。它读取一次原子检查点，校验指定字节前缀的完整行、SHA-256 和最后接收序号。输出目录必须尚不存在；写入中带 `incomplete.json`，完整后移除。

| 输出                        | 内容                                                 |
| --------------------------- | ---------------------------------------------------- |
| `events.jsonl`              | 稳定伪名的冻结语料；成员在同账号的多个群保持同一伪名 |
| `identity-map.private.json` | 单独的私有身份映射，用于配置目标及审计               |
| `manifest.json`             | 来源哈希、捕获字节/序号水位、转换协议和记录数        |

身份字段与正规化 @/reply 占位标识同步转换，显示名设为 null。消息自然语言仍可能包含个人信息，公开前须审核正文；身份映射留在受控存储。给候选提供输入前，先将映射与语料分开管理。导出不查询当前昵称、不补抓历史消息，也不调用模型。

参照 `example-config.json`，用导出语料里的伪名 `scope` 与目标 `senderId` 填写配置，将 `dataKind` 设为 `private`，按实际覆盖区间指定 history/dev/test 时间块。每个导出群至少配置一个目标。

```bash
python3 benchmarks/participation/bench.py prepare \
  --source .data/participation-capture/frozen/events.jsonl \
  --config .data/participation-capture/config.json \
  --output .data/participation-capture/dataset

python3 benchmarks/participation/bench.py preview \
  --dataset .data/participation-capture/dataset \
  --output .data/participation-capture/preview

python3 benchmarks/participation/bench.py evaluate \
  --dataset .data/participation-capture/dataset \
  --output .data/participation-capture/report
```

首个实际试采集采用一个账号、一个群、一个目标，检查自身消息、撤回、引用、重复、断线及覆盖计数，再扩大语料。固定来源及完整请求预览可用于后续 Planner/Memory 对照；正式外部模型调用继续单独授权。
