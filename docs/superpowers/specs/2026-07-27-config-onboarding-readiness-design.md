# 配置引导与完整性设计

## 背景

本设计解决 GitHub Issue
[#4](https://github.com/posanbu/Kaguya/issues/4)：无配置时应当提供配置引导，而不是自动创建空的默认配置并在运行时回退到它。

当前 `FileUserConfigManager.open()` 会在 `index.json` 不存在时创建一个名为
`default` 的空 profile。该 profile 没有 AI provider、模型、平台或插件，
`resolveProfile()` 仍会将未绑定会话解析到它。新的行为必须区分：

- 完全没有配置，需要进入配置引导；
- 配置存在但不完整，需要明确报错；
- 配置主体有效，但缺少可选项，需要用户明确确认；
- 配置完整且已确认，可以参与会话解析。

## 目标

- 首次使用时提供机器可读的配置引导，不写入空默认配置。
- Multi-agent 运行前至少配置两个可用模型。
- 模型配置有问题时直接报错，不回退其他 profile、provider 或模型。
- 可选配置缺失时阻断运行并显式提示，不静默使用默认值。
- 保留多 profile、默认 profile 和会话绑定语义。
- 让后续 Web UI 可以直接消费稳定的 readiness 状态和引导步骤。

## 非目标

- 本次不实现 Web UI 或交互式终端向导。
- 不探测远程模型是否真实存在或可访问；provider 的网络和鉴权错误由执行层直接返回。
- 不实现 provider 故障转移、模型自动切换或隐式 fallback。
- 不增加跨 manager 实例或跨进程协调。

## 配置状态

新增判别联合 `ConfigurationReadiness`：

```ts
type ConfigurationReadiness =
  | {
      status: "setup_required";
      guidance: ConfigurationGuidance;
    }
  | {
      status: "invalid";
      issues: readonly ConfigurationIssue[];
    }
  | {
      status: "review_required";
      warnings: readonly ConfigurationWarning[];
    }
  | {
      status: "ready";
    };
```

状态优先级固定为：

1. 配置仓库不存在：`setup_required`；
2. profile 模型配置不完整：`invalid`；
3. profile 存在尚未确认的可选项：`review_required`；
4. 其余情况：`ready`。

状态只包含固定 issue ID、字段路径和引导文案，不包含 API key、
credentials、settings 原始值或 Zod cause。

## 首次配置

`FileUserConfigManager.open({ rootDir })` 不再创建空 profile。缺少
`index.json` 时抛出固定、无 cause 的 `CONFIG_SETUP_REQUIRED`。

新增只读检查：

```ts
FileUserConfigManager.inspect({
  rootDir,
}): Promise<ConfigurationReadiness>;
```

当仓库不存在时，`inspect()` 不创建根目录、`profiles/`、`index.json` 或
profile 文件，返回的 guidance 包含以下固定步骤：

1. 创建第一份 profile；
2. 添加并启用 AI provider；
3. 配置至少两个模型；
4. 设置默认 provider；
5. 检查并确认可选配置。

新增显式初始化：

```ts
FileUserConfigManager.initialize({
  rootDir,
  name,
  settings,
  acknowledgedWarnings,
}): Promise<FileUserConfigManager>;
```

初始化输入存在模型错误或未确认 warning 时不写入任何 index/profile。
初始化成功后，首份 profile 同时成为默认 profile。

## 模型完整性

profile 的运行时完整性必须满足：

- `defaultProviderId` 存在并引用已启用 provider；
- 每个已启用 provider 至少包含一个模型；
- 同一 provider 内的模型 ID 不重复；
- 以 `providerId:modelId` 作为运行目标标识；
- 所有已启用 provider 的运行目标去重后总数至少为两个。

同一 provider 下的两个不同模型有效；不同 provider 下的模型也有效。
相同模型名称位于不同 provider 时属于两个不同运行目标。

结构 schema 继续允许旧的空 profile 被读取和编辑，避免旧仓库无法迁移；
readiness 检查负责阻止它参与会话解析。创建、更新和初始化返回的结构输入错误仍使用
`CONFIG_INVALID_INPUT`，运行前模型完整性错误使用
`CONFIG_INCOMPLETE`。

配置包不调用模型网络接口，因此“模型有问题”在本层表示 provider/model
引用和数量不合法。模型不存在、鉴权失败、不可达或响应错误由执行层直接报错，
不得切换其他模型。

## 可选配置确认

以下情况生成稳定 warning：

- 已启用 provider 缺少 `baseUrl`；
- 已启用 provider 缺少 `apiKey`；
- `platforms` 为空；
- `plugins` 为空。

warning ID 使用稳定、无敏感值的格式，例如：

```text
provider-base-url-missing:<providerId>
provider-api-key-missing:<providerId>
platforms-empty
plugins-empty
```

profile 新增显式确认记录：

```ts
review: {
  acknowledgedWarnings: string[];
}
```

旧 profile 缺少 `review` 字段时按未确认处理，不自动补写确认记录。

新增：

```ts
manager.inspectProfile(profileId): Promise<ProfileReadiness>;

manager.acknowledgeConfigurationWarnings(
  profileId,
  warningIds,
): Promise<void>;
```

确认 API 只接受当前 profile 实际存在的 warning ID。确认记录与 profile 一起以敏感
JSON 管理。每次 `updateProfile()` 都清空该 profile 的确认记录并重新计算 warning，
防止旧确认覆盖变更后的配置。

显式填写的空 `settings`、空 `credentials` 和禁用 provider 不产生 warning。

## 会话解析

`resolveProfile(sessionId)` 的顺序为：

1. 等待当前 manager 的写队列；
2. 选择显式绑定的 profile，未绑定时选择 `defaultProfileId`；
3. 检查选中 profile 的 readiness；
4. `invalid` 时抛出 `CONFIG_INCOMPLETE`；
5. `review_required` 时抛出 `CONFIG_REVIEW_REQUIRED`；
6. `ready` 时返回 profile。

显式绑定的 profile 不完整时不得尝试默认 profile。默认 profile 不完整时不得搜索
其他 profile。配置包不执行 provider 或模型 fallback。

## 错误契约

`ConfigErrorCode` 新增：

- `CONFIG_SETUP_REQUIRED`
- `CONFIG_INCOMPLETE`
- `CONFIG_REVIEW_REQUIRED`

`CONFIG_SETUP_REQUIRED` 提供固定配置步骤；
`CONFIG_INCOMPLETE` 提供模型配置 issue ID 和字段路径；
`CONFIG_REVIEW_REQUIRED` 提供尚未确认的 warning ID 和字段路径。

错误必须保持固定、无 cause、无配置值，`String(error)` 和
`JSON.stringify(error)` 均不能泄露密钥。

## 兼容与迁移

- 已存在且完整的 profile 可以继续打开。
- 旧的空 `default` profile 可以打开、列出和更新，但不能用于会话解析。
- 不自动删除或替换旧 profile。
- 不自动生成 provider、模型、平台、插件、URL、密钥或确认记录。
- 原有默认 profile 和会话绑定只负责选择 profile，不代表该 profile 可以运行。

## 测试范围

测试保持精简，覆盖核心契约：

1. 空目录 `inspect()` 返回引导且无文件副作用，`open()` 抛
   `CONFIG_SETUP_REQUIRED`；
2. 一个模型被拒绝，跨同一或不同 provider 的两个模型可以通过完整性检查；
3. 缺少可选项时阻断，确认当前 warning 后可以解析，profile 更新后确认失效；
4. 未绑定和显式绑定会话选中的 profile 不完整时均直接报错，不发生 fallback；
5. readiness 和错误字符串不包含测试密钥。

不为每个字段、provider 排列或 warning 组合重复测试；现有 schema、原子写入、
队列、路径和权限测试继续覆盖底层行为。
