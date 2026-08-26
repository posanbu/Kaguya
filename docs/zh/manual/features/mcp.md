---
title: MCP 工具集成
---

# MCP 工具集成

MaiBot 通过 MCP（Model Context Protocol）协议连接外部工具服务器，让 Maisaka 推理引擎获得超出对话本身的能力——浏览器自动化、文件操作、代码执行、API 调用，都可以通过 MCP 工具实现。

## 什么是 MCP？

MCP（Model Context Protocol）是一个开放协议标准，定义了 AI 应用如何与外部工具和服务进行连接与交互。在 MCP 的世界里，有**客户端**和**服务端**两种角色：

- **MCP 服务端（Server）**：暴露工具、提示词、资源等能力的服务程序。比如一个"浏览器自动化"服务端会提供网页截图、点击元素等工具。
- **MCP 客户端（Client）**：连接到服务端，发现并使用其能力的程序。**MaiBot 就是 MCP 客户端**。

::: tip 关键理解
MaiBot 自身不包含天气查询、股票查询、网页搜索等内置工具。这些能力全部来自你连接的 MCP 服务端——MaiBot 负责发现和调用它们，具体能做什么取决于你连了哪些服务器。
:::

MCP 工具对 Maisaka 推理引擎来说是**透明**的——MCP 工具和内置工具（`reply`、`wait`、`finish` 等）走同一个 ToolProvider 接口，规划器无需区分它们的来源。

## 架构概览

MCP 模块位于 `maibot/src/mcp_module/`，由以下核心组件构成：

```
mcp_module/
├── __init__.py          # 包入口，导出 MCPManager
├── manager.py           # MCPManager — 全局管理器
├── connection.py        # MCPConnection — 单服务器连接
├── provider.py          # MCPToolProvider — Maisaka 工具集成
├── host_llm_bridge.py   # MCPHostLLMBridge — Sampling → LLM 桥接
├── hooks.py             # MCPHostCallbacks — 宿主回调声明
├── models.py            # 结构化数据模型与转换
└── config.py            # TOML → 运行时配置转换
```

各组件职责：

- **MCPManager**（manager.py）— 全局管理器，管理所有服务器连接，提供统一的工具/Prompt/Resource 访问入口
- **MCPConnection**（connection.py）— 管理单个服务器的连接生命周期：连接 → 发现能力 → 调用 → 断开
- **MCPToolProvider**（provider.py）— 将 MCPManager 包装为标准 ToolProvider，对接 Maisaka 规划器
- **MCPHostLLMBridge**（host_llm_bridge.py）— 将 MCP Sampling 请求桥接到 MaiBot 自身的 LLM 调用链
- **MCPHostCallbacks**（hooks.py）— 宿主侧回调集合（Sampling、Elicitation、日志等）
- **Models**（models.py）— MCP SDK 原始对象与主程序内部模型的转换层
- **Config**（config.py）— 将 TOML 配置转换为类型化的 dataclass

## 四种能力类型

MCP 服务端可以暴露四种类型的能力：

### 1. 工具（Tools）

可执行函数，带有输入/输出 Schema。这是最常用的能力类型——MCP 工具会被注册到 MaiBot 的工具注册表，Maisaka 规划器可以像调用内置工具一样调用它们。

每个工具包含：
- **名称**（name）：全局唯一的工具标识符
- **描述**（description）：工具功能的自然语言描述
- **输入 Schema**（inputSchema）：JSON Schema 格式的参数定义
- **输出 Schema**（outputSchema）：可选的返回值结构定义
- **注解**（annotations）：可选的受众、优先级等元信息

### 2. 提示词（Prompts）

预定义的提示词模板，支持可选参数。可以被获取后用于构建对话上下文。

每个提示词包含：
- **名称**（name）：唯一标识
- **参数列表**（arguments）：可选的模板参数，每个参数可标记为必填
- **描述**（description）：模板功能说明

### 3. 资源（Resources）

通过 URI 访问的静态数据或文件。服务端暴露的资源有固定的 URI，客户端可以直接读取。

每个资源包含：
- **URI**：资源的唯一地址
- **名称/描述**：人类可读标识
- **MIME 类型**：资源的内容格式

### 4. 资源模板（ResourceTemplates）

参数化的资源 URI，使用 URI 模板语法（如 `file:///logs/{date}/report.md`）。客户端可以传入参数构造具体的资源 URI。

MCPManager 对四种能力分别维护独立的注册表，并在注册时进行冲突检测——如果两个服务器暴露了相同名称的工具或相同 URI 的资源，只有第一个会注册成功，后续的会被跳过并输出警告。

## 传输模式

MaiBot 支持三种 MCP 传输方式：

### stdio（本地子进程）

通过启动本地子进程来运行 MCP 服务器。MaiBot 使用 `command` 和 `args` 配置启动命令，通过标准输入/输出与服务器通信。

- **无需网络**，延迟最低
- 适合本地安装的工具（文件操作、浏览器自动化等）
- 推荐使用 `uvx`（来自 [uv](https://docs.astral.sh/uv/)）运行，自动管理依赖

::: code-group

```toml [stdio ~vscode-icons:file-type-toml~]
[[mcp.servers]]
name = "playwright"
transport = "stdio"
command = "uvx"
args = ["@playwright/mcp"]
```

:::

::: tip 使用 uvx
`uvx` 是 Python 工具运行器，无需手动安装 MCP 服务器包，会自动从 PyPI 拉取并运行。确保你的环境中已安装 [uv](https://docs.astral.sh/uv/)。
:::

### streamable_http（远程 HTTP）

通过 HTTP 连接远程 MCP 服务器端点。适合云服务或他人部署好的工具。

- **需要网络连接**
- 支持 Bearer Token 认证和自定义请求头
- 支持配置超时时间

::: code-group

```toml [streamable_http ~vscode-icons:file-type-toml~]
[[mcp.servers]]
name = "remote-api"
transport = "streamable_http"
url = "https://mcp.example.com/api"

[mcp.servers.authorization]
mode = "bearer"
bearer_token = "sk-your-token"
```

:::

### sse（Server-Sent Events）

通过 SSE 连接远程 MCP 服务器。适合需要长连接推送的远程服务。

- **需要网络连接**
- 支持 Bearer Token 认证和自定义请求头
- 支持配置超时时间

::: code-group

```toml [sse ~vscode-icons:file-type-toml~]
[[mcp.servers]]
name = "remote-sse"
transport = "sse"
url = "https://mcp.example.com/sse"

[mcp.servers.authorization]
mode = "bearer"
bearer_token = "sk-your-token"
```

:::

MaiBot 内部使用 `mcp` Python SDK 的 `stdio_client`、`streamable_http_client` 和 `sse_client` 实现三种传输。

## 连接生命周期

MCP 模块的启动流程如下：

```
1. MCPManager.from_app_config()
   ├─ 读取 TOML 配置，转换为运行时 dataclass
   ├─ 检查 mcp SDK 是否已安装
   └─ 遍历所有 enabled 的服务器配置
       └─ 对每个服务器：
           ├─ 创建 MCPConnection
           ├─ 根据传输类型建立连接（stdio / streamable_http）
           ├─ 调用 session.initialize() 初始化 MCP 会话
           ├─ 加载服务端能力（分页获取 Tools/Prompts/Resources/Templates）
           └─ 注册到管理器，进行冲突检测
2. 全部完成后输出连接摘要
```

### 启动日志示例

连接成功时，日志中会看到：

```
✓ MCP 服务器 'playwright' 已连接 (工具 12 / Prompt 0 / 资源 0 / 模板 0)
```

如果某个服务器连接失败，会输出警告并跳过，不影响其他服务器。如果**所有**服务器都连接失败，MCPManager 返回 `None`，MCP 功能会被优雅地禁用，MaiBot 仍可正常运行。

### 分页加载

所有能力发现（list_tools、list_prompts、list_resources、list_resource_templates）都支持基于游标（cursor）的分页。MaiBot 会自动循环获取所有页面，直到没有下一页为止。

## 工具集成与 Maisaka

### ToolProvider 接口

MCP 工具通过 `MCPToolProvider` 集成到 Maisaka。该类实现了标准的 `ToolProvider` 接口：

- `list_tools()` → 返回所有 MCP 工具的 `ToolSpec` 列表
- `invoke(invocation)` → 将工具调用请求路由到正确的 MCPConnection

MCPToolProvider 在 MaiBot 启动时注册到工具注册表：

::: code-group

```python [Python ~vscode-icons:file-type-python~]
tool_registry.register_provider(MCPToolProvider(manager))
```

:::

此后，Maisaka 规划器就能看到并使用这些 MCP 工具，与内置工具完全一致。

### 工具调用流程

```
Maisaka 规划器选择某个工具
  → ToolRegistry 查找对应 Provider
  → MCPToolProvider.invoke()
    → MCPManager.call_tool_invocation()
      → 根据 _tool_to_server 映射找到目标服务器
      → MCPConnection.call_tool()
        → MCP SDK session.call_tool()
        → 返回 ToolExecutionResult
```

### 名称冲突与保护

MCPManager 对工具名称有两层保护：

1. **内置工具保护**：   以下名称是 MaiBot 内置工具，MCP 工具不允许占用：

   - **`reply`** — 回复消息
   - **`no_action`** — 本轮不进行任何动作
   - **`stop`** — 停止
   - **`create_table`** — 创建表格
   - **`list_tables`** — 列出表格
   - **`view_table`** — 查看表格

   如果 MCP 服务器暴露了与内置工具同名的工具，该工具会被跳过并输出警告。

2. **跨服务器冲突检测**：如果两个 MCP 服务器暴露了同名工具，只有第一个注册的服务器会成功，后续的会被跳过。注册顺序与 `bot_config.toml` 中的配置顺序一致。

同样，Prompt 和 Resource 也有冲突检测机制（Prompt 按名称、Resource 按 URI、ResourceTemplate 按 URI 模板）。

## 客户端能力

除了使用 MCP 服务端暴露的能力，MaiBot 作为客户端也可以声明自身的能力，让服务端反过来利用。

### Roots（文件系统路径暴露）

允许你向 MCP 服务器暴露本地文件系统的部分路径，让服务器知道它可以读写哪些目录。

::: code-group

```toml [Roots ~vscode-icons:file-type-toml~]
[mcp.client.roots]
enable = true

[[mcp.client.roots.items]]
enabled = true
uri = "file:///home/mai/data"
name = "麦麦的数据目录"
```

:::

典型场景：连接文件系统 MCP 服务器（如 `@modelcontextprotocol/server-filesystem`）时，开启 Roots 后服务器就能知道你的数据目录在哪里，直接操作该目录下的文件。

### Sampling（采样 / LLM 调用桥接）

允许 MCP 服务端**反过来请求 MaiBot 调用大模型**来完成某些任务。这是一个高级的双向能力，通过 `MCPHostLLMBridge` 实现：

```
MCP 服务端发起 Sampling 请求
  → MCPConnection 收到 sampling_callback
    → MCPHostLLMBridge.handle_sampling_request()
      → 转换 MCP 消息格式为内部 Message 格式
      → 通过 LLMServiceClient 调用配置的模型任务
      → 将响应转换回 MCP CreateMessageResult
```

::: code-group

```toml [Sampling ~vscode-icons:file-type-toml~]
[mcp.client.sampling]
enable = true
task_name = "planner"     # 执行 Sampling 时使用的模型任务名
tool_support = true       # 允许 Sampling 中继续使用工具
```

:::

::: warning ⚠️ Sampling 会消耗 Tokens
启用 Sampling 意味着 MCP 服务端可以触发 MaiBot 的模型调用，会产生额外的 API 费用。确保 `task_name` 指向一个已配置好的模型任务。
:::

### Elicitation（引导）

允许 MCP 服务端请求用户填写表单或在浏览器中打开 URL。目前 UI 层尚未完全实现，但能力声明已在协议层预留。

::: code-group

```toml [Elicitation ~vscode-icons:file-type-toml~]
[mcp.client.elicitation]
enable = true
allow_form = true   # 允许表单模式
allow_url = false   # 允许 URL 模式
```

:::

## 工具结果的内容类型

MCP 工具的返回结果可以包含多种内容类型，MaiBot 会统一处理：

- **`text`** — 纯文本结果，最常见的形式
- **`image`** — Base64 编码的图片（支持 PNG、JPEG、WebP、GIF）
- **`audio`** — 音频数据
- **`resource_link`** — 对 MCP 资源的引用（包含 URI 和描述）
- **`resource`** — 嵌入的资源内容（文本或二进制数据）

一次工具调用的结果可以包含多个内容项（例如同时返回文本说明和截图），MaiBot 会将它们组合后传递给 Maisaka。

## 前置条件

MCP 功能依赖 `mcp` Python 包，这是一个**可选依赖**——如果你不使用 MCP，不需要安装它。

如果 MaiBot 检测到配置了 MCP 服务器但未安装 `mcp` 包，启动时会提示：

```
⚠️ 发现 MCP 配置但未安装 mcp SDK，请运行: pip install mcp
```

安装方式：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install mcp
```

:::

::: tip 无 MCP 也能运行
即使没有任何 MCP 配置或未安装 `mcp` 包，MaiBot 也会正常运行——MCP 是完全可选的增强功能。
:::

## 配置示例

以下是一些真实的 MCP 服务器配置示例。详细的配置字段说明请参阅 [MCP 配置](../configuration/mcp-config.md)。

### Playwright 浏览器自动化

::: code-group

```toml [Playwright ~vscode-icons:file-type-toml~]
[mcp]
enable = true

[[mcp.servers]]
name = "playwright"
transport = "stdio"
command = "uvx"
args = ["@playwright/mcp"]
```

:::

连接后，Maisaka 可以使用 Playwright 提供的浏览器自动化工具（导航网页、截图、点击元素等）。

### 文件系统服务器（配合 Roots）

::: code-group

```toml [Filesystem ~vscode-icons:file-type-toml~]
[mcp]
enable = true

[mcp.client.roots]
enable = true

[[mcp.client.roots.items]]
enabled = true
uri = "file:///home/mai/data"
name = "数据目录"

[[mcp.servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/home/mai/data"]
```

:::

通过 Roots 能力，文件系统服务器知道 MaiBot 允许访问的目录范围。

### GitHub 服务器（带 Token）

::: code-group

```toml [GitHub ~vscode-icons:file-type-toml~]
[mcp]
enable = true

[[mcp.servers]]
name = "github"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "ghp_your_token_here" }
```

:::

GitHub MCP 服务器需要通过环境变量传入 Personal Access Token。

### 远程 HTTP 服务器（Bearer 认证）

::: code-group

```toml [Remote HTTP ~vscode-icons:file-type-toml~]
[mcp]
enable = true

[[mcp.servers]]
name = "remote-api"
transport = "streamable_http"
url = "https://api.example.com/mcp"

[mcp.servers.authorization]
mode = "bearer"
bearer_token = "sk-your-api-token"
```

:::

## 故障排除

### 检查启动日志

MaiBot 启动时会打印每个 MCP 服务器的连接状态。如果连接成功，会显示：

```
✓ MCP 服务器 'playwright' 已连接 (工具 12 / Prompt 0 / 资源 0 / 模板 0)
```

如果失败，会显示错误信息：

```
⚠️ MCP 服务器 'xxx' 连接失败: <错误详情>
```

### 常见问题

- **`⚠️ 发现 MCP 配置但未安装 mcp SDK`** — 未安装 `mcp` Python 包 → 运行 `pip install mcp`
- **工具名称冲突被跳过** — MCP 工具与内置工具或其他服务器工具同名 → 检查日志中的冲突警告，调整服务器配置
- **stdio 服务器启动失败** — `command` 路径不正确或命令不存在 → 确认命令在环境中可用，推荐使用 `uvx`
- **环境变量未生效** — `env` 配置格式错误 → 确认使用 `{ KEY = "value" }` 格式
- **远程服务器连接超时** — 网络问题或服务器不可达 → 检查网络连接，增大 `http_timeout_seconds`
- **Bearer Token 认证失败** — Token 无效或过期 → 重新获取 Token 并更新配置

### 独立验证 MCP 服务器

在连接 MaiBot 之前，可以使用 `mcp` SDK 自带的工具独立验证服务器是否正常工作：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
mcp inspect uvx @playwright/mcp
```

:::

这可以帮助你排除 MaiBot 之外的问题。

## 相关文档

- [MCP 配置](../configuration/mcp-config.md) — 完整的 TOML 配置字段说明
- [Bot 配置总览](../configuration/bot-config.md) — 全局配置参考
- [Maisaka 推理引擎](./maisaka-reasoning.md) — 了解 MCP 工具如何参与推理规划
