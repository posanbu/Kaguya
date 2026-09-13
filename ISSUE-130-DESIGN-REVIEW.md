# Issue #130：跨会话目标解析与授权评审稿

状态：用户已在任务中回复 approved 批准设计；实现与验证已完成。代码基线为 `origin/main` 的 `f1f6c21`。

本稿对应 https://github.com/posanbu/Kaguya/issues/130 。该 issue 明确要求先人工锁定 adapter 查询、稳定身份、权限继承和高风险确认策略，再实现跨会话能力。

## 当前代码事实

`packages/platform-adapters/src/hosted.ts` 的 HostedAdapter 只有生命周期和 outboundTransport，没有目标目录。NapCatActionClient 只处理发送 action。`packages/runtime/src/gateway-allowlist.ts` 目前接收入站结构，空白名单拒绝非 Web 平台，Web 始终通过。

`packages/modules/src/first-party/information-kinds.ts` 已有统一 MessageTarget `{adapterId, platform, destination}`，message intent 还要求冻结 turn provenance 和 memoryInformationIds。Heartflow 当前确定性地从冻结 turn 最后一个输入取地址；Planner 的 message/wait/silent 输出不含目标。Runtime 的 `#deliver` 检查持久终态后直接寻找 transport 并发送，缺少最终目标权限检查。

## 建议锁定的行为

**候选来源与稳定身份** — 只向启用且 running/connected 的 adapter 查询。为 HostedAdapter 增加可选目录能力；NapCat 通过 OneBot 群列表和好友列表获得群聊及私聊候选。首版不把任意陌生人或群成员当作可私聊候选。查询失败、断线、能力缺失和不完整目录显式报告，不能当作完整的空列表，更不能据此断言唯一匹配。平台列表只能证明查询时可见，实际发送失败仍走 delivery 终态。

候选稳定键使用 adapterId、platform、destination.kind 和字符串 ID；名称仅是可变展示字段。绑定 adapter 的账号与连接代次；账号变化、重连或重新应用配置使旧候选授权失效。同 ID 的不同 adapter 不自动合并。查询不把数值 ID 转成可能丢精度的浮点数。

**解析与消歧** — 使用有类型的精确 ID 查询和名称查询。唯一精确名称可进入授权；自然语言描述仅用于生成候选建议，须选定候选后重新校验，不能由模型自行确定最终地址。显式结果至少包括 resolved、ambiguous、not-found、unavailable、unauthorized、confirmation-required、expired。多匹配返回短期 opaque 候选引用供消歧，选择时重新检查目录及权限。不向普通会话暴露完整目录或未授权候选详情。

**权限继承** — 目标必须满足当前生效的 GatewayAllowlist；来源会话或发言者获准入站不意味着其拥有任何跨会话发送权限。首版所有跨会话发送都由已认证管理端确认，普通聊天和模型输出只能提出请求。空策略拒绝非 Web 出站；通配白名单只代表目标允许范围，不豁免跨会话确认。Web 保持现有认证及特殊投递策略，不参加 QQ 目录枚举。

**高风险确认** — 首版将所有跨会话发送视为需要确认；群发不支持。管理端先确认规范目标、源 turn 及允许携带的上下文，再创建统一 message intent。Composer 生成后，管理端确认最终文本再释放原有 delivery 请求。确认绑定请求、目标、内容摘要、配置代次与有效期，单次消费；修改目标或正文须重新确认，超时和重启后的未完成确认须重新发起。这样既能在 intent 前阻止未授权目标，又能让人审查实际将发送的内容。

跨会话不能默认复制源群全部历史或 Memory。构造专用冻结上下文，仅包含管理端批准的发送要求及明确授权的资料；保持 #128 的 turn provenance/Memory ID 契约。上下文隔离必须与正常发送一起验证。

## 统一发送链与可信边界

解析器由宿主提供，只接受查询或候选引用；解析和授权通过后在服务端保存授权事实，以 information reference 关联既有 `agent.message.intent.requested`。不得增加第二种发送 intent 或直接调用 adapter。保留当前会话 Planner 行为；如增加跨会话请求分支，只允许表达查询，不接受模型生成的 adapterId/destination。

Composer 消费跨会话 intent 前核验授权事实、turn、目标、配置代次和上下文范围。授权不是 TypeScript branded type 或可自行提交的布尔字段。手工构造的原子、复制授权引用、重放过期候选都不能使验证成功。当前会话免确认路径必须与冻结来源目标精确一致，不能通过修改目的地址取得豁免。

Server 将当前生效策略注入 Runtime。Runtime 在每次调用 transport 前同步检查最终 `{platform, destination}`；跨会话还须校验有效确认及内容绑定。保存/选择 Profile 不改变策略，只有显式应用成功才切换。当前配置应用会替换 Runtime/AdapterHost，应保证恢复领取的未完成请求使用新策略。

白名单拒绝不调用 transport，提交唯一 `core.delivery.failed` 终态，使用安全错误码 `destination-not-allowed`；关联 turn 按投递失败关闭。拒绝事件只保留必要的引用、platform、adapterId、目标类型和安全错误码，不复制原始 ID、消息或 adapter 错误。现有失败 payload 要求 target，因此实现时需调整失败 schema 及所有消费者，避免用伪造 ID 满足旧 schema。普通日志和消费者故障日志同样不能泄漏请求正文或目标。

## 实施与验收

- 扩展 adapter 目录及 NapCat action 请求关联，测试成功、超时、断线、畸形响应、重复 ID、多账号和目录不完整。
- 实现宿主解析/授权服务与受认证的管理端消歧、确认入口，测试 ID、唯一名称、同名、自然语言建议、无匹配、未授权及 adapter 不可用；不可执行结果不能产生 intent 或 delivery。
- 接入统一 intent/composer/delivery，测试目标与正文确认、上下文隔离、伪造原子、引用复用、过期、重启及幂等消费。
- 注入 Runtime 最终策略并测试白名单群/私聊成功，拒绝时 transport 调用为零、失败码正确、turn 关闭、日志脱敏；涵盖错误模块请求、重放和显式应用收紧权限。验证 Web 原有行为。
- 更新公开契约、配置与用户文档，运行 build、typecheck、lint、Vitest、PostgreSQL 集成测试和 promptfoo。用模拟 adapter 验证发送，不向真实群或用户发送测试消息。

## 需要人工评审的决定

建议整体批准上述首版边界：群列表/好友列表目录；adapter 与账号绑定的稳定身份；白名单不继承跨会话发信权；所有跨会话发送经过管理端目标和最终正文两阶段确认；跨会话上下文须单独授权。如果希望部分跨会话目标自动发送，需要先明确可信操作者、授权范围和正文/数据外发限制，再调整本稿。

## 实现验证记录

实现采用独立跨会话 candidate/claim，以 `agent.message.target.authorized` 保存批准的冻结说明和来源 turn 溯源。该上下文不会交给 Association 扩展记忆；Composer 通过宿主窄能力获取批准 Prompt，确认正文后复用原有 release 和 delivery 终检。

验证包括全量 Vitest（992 项通过、44 项按配置跳过）、补充确认引用链测试（1 项通过）、PostgreSQL 集成（70 项通过）、promptfoo（5 项通过）、build、typecheck、lint 和文档构建/链接检查。WebUI 使用本机合成 API 验证了目标选择与两次确认；未向真实 QQ 群或用户发送测试消息。
