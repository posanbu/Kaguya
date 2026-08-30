---
title: MCP Tool Integration
---

# MCP Tool Integration

MaiBot connects to external tool servers through MCP (Model Context Protocol), giving the Maisaka reasoning engine capabilities beyond conversation itself — browser automation, file operations, code execution, and API calls can all be implemented through MCP tools.

## What is MCP?

MCP (Model Context Protocol) is an open protocol standard that defines how AI applications connect and interact with external tools and services. In the MCP world, there are two roles: **clients** and **servers**:

- **MCP Server** — A service program that exposes capabilities such as tools, prompts, and resources. For example, a "browser automation" server provides tools like webpage screenshots and element clicking.
- **MCP Client** — A program that connects to servers, discovers and uses their capabilities. **MaiBot is the MCP client**.

::: tip Key Understanding
MaiBot itself does not ship built-in tools for weather, stocks, or web search. Those capabilities all come from the MCP servers you connect to — MaiBot discovers and invokes them; what it can do depends on which servers you have connected.
:::

MCP tools are **transparent** to the Maisaka reasoning engine — MCP tools and built-in tools (`reply`, `wait`, `finish`, etc.) go through the same ToolProvider interface, so the planner does not need to distinguish their origin.

## Architecture Overview

The MCP module lives in `maibot/src/mcp_module/` and consists of these core components:

```
mcp_module/
├── __init__.py          # Package entry, exports MCPManager
├── manager.py           # MCPManager — global manager
├── connection.py        # MCPConnection — single-server connection
├── provider.py          # MCPToolProvider — Maisaka tool integration
├── host_llm_bridge.py   # MCPHostLLMBridge — Sampling → LLM bridge
├── hooks.py             # MCPHostCallbacks — host callback declarations
├── models.py            # Structured data models and conversions
└── config.py            # TOML → runtime configuration conversion
```

Component responsibilities:

- **MCPManager** (manager.py) — Global manager; manages all server connections and provides a unified entry for Tools/Prompts/Resources
- **MCPConnection** (connection.py) — Manages a single server's connection lifecycle: connect → discover capabilities → invoke → disconnect
- **MCPToolProvider** (provider.py) — Wraps MCPManager as a standard ToolProvider for the Maisaka planner
- **MCPHostLLMBridge** (host_llm_bridge.py) — Bridges MCP Sampling requests into MaiBot's own LLM call chain
- **MCPHostCallbacks** (hooks.py) — Host-side callback collection (Sampling, Elicitation, logging, etc.)
- **Models** (models.py) — Conversion layer between raw MCP SDK objects and the main program's internal models
- **Config** (config.py) — Converts TOML configuration into typed dataclasses

## Four Capability Types

An MCP server can expose four types of capabilities:

### 1. Tools

Executable functions with input/output schemas. This is the most commonly used capability type — MCP tools are registered into MaiBot's tool registry, and the Maisaka planner can invoke them just like built-in tools.

Each tool contains:

- **name** — A globally unique tool identifier
- **description** — A natural-language description of what the tool does
- **inputSchema** — Parameter definition in JSON Schema format
- **outputSchema** — Optional structure definition of the return value
- **annotations** — Optional metadata such as audience and priority

### 2. Prompts

Predefined prompt templates with optional parameters. They can be fetched and used to build conversation context.

Each prompt contains:

- **name** — Unique identifier
- **arguments** — Optional template parameters, each can be marked as required
- **description** — Description of what the template does

### 3. Resources

Static data or files accessible by URI. Resources exposed by a server have fixed URIs that the client can read directly.

Each resource contains:

- **URI** — The resource's unique address
- **name/description** — Human-readable identifiers
- **MIME type** — The content format of the resource

### 4. ResourceTemplates

Parameterized resource URIs using URI template syntax (e.g. `file:///logs/{date}/report.md`). The client can pass parameters to construct concrete resource URIs.

MCPManager maintains a separate registry for each of the four capability types and performs conflict detection at registration time — if two servers expose tools with the same name or resources with the same URI, only the first one is registered; the rest are skipped with a warning.

## Transport Modes

MaiBot supports three MCP transport modes:

### stdio (Local Subprocess)

Runs the MCP server as a local subprocess. MaiBot starts the command using the `command` and `args` configuration and communicates with the server over standard input/output.

- **No network needed**, lowest latency
- Suited for locally installed tools (file operations, browser automation, etc.)
- Using `uvx` (from [uv](https://docs.astral.sh/uv/)) is recommended — it manages dependencies automatically

::: code-group

```toml [stdio ~vscode-icons:file-type-toml~]
[[mcp.servers]]
name = "playwright"
transport = "stdio"
command = "uvx"
args = ["@playwright/mcp"]
```

:::

::: tip Using uvx
`uvx` is a Python tool runner — no need to manually install the MCP server package; it pulls and runs it from PyPI automatically. Make sure [uv](https://docs.astral.sh/uv/) is installed in your environment.
:::

### streamable_http (Remote HTTP)

Connects to a remote MCP server endpoint over HTTP. Suited for cloud services or tools deployed by others.

- **Requires network access**
- Supports Bearer Token authentication and custom request headers
- Supports configurable timeouts

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

### sse (Server-Sent Events)

Connects to a remote MCP server over SSE. Suited for remote services that need long-lived connections and push.

- **Requires network access**
- Supports Bearer Token authentication and custom request headers
- Supports configurable timeouts

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

Internally, MaiBot uses the `stdio_client`, `streamable_http_client`, and `sse_client` from the `mcp` Python SDK to implement the three transports.

## Connection Lifecycle

The MCP module startup flow is as follows:

```
1. MCPManager.from_app_config()
   ├─ Read TOML config, convert to runtime dataclasses
   ├─ Check whether the mcp SDK is installed
   └─ Iterate over all enabled server configs
       └─ For each server:
           ├─ Create an MCPConnection
           ├─ Establish the connection per transport type (stdio / streamable_http)
           ├─ Call session.initialize() to initialize the MCP session
           ├─ Load server capabilities (paginate Tools/Prompts/Resources/Templates)
           └─ Register into the manager with conflict detection
2. Output a connection summary after all are done
```

### Example Startup Log

On a successful connection, you will see in the logs:

```
✓ MCP server 'playwright' connected (Tools 12 / Prompts 0 / Resources 0 / Templates 0)
```

If a server fails to connect, a warning is printed and it is skipped without affecting other servers. If **all** servers fail, MCPManager returns `None`, MCP functionality is gracefully disabled, and MaiBot still runs normally.

### Paginated Loading

All capability discovery calls (list_tools, list_prompts, list_resources, list_resource_templates) support cursor-based pagination. MaiBot automatically loops through all pages until there is no next page.

## Tool Integration with Maisaka

### ToolProvider Interface

MCP tools are integrated into Maisaka through `MCPToolProvider`, which implements the standard `ToolProvider` interface:

- `list_tools()` → Returns the `ToolSpec` list of all MCP tools
- `invoke(invocation)` → Routes the tool invocation to the correct MCPConnection

MCPToolProvider is registered into the tool registry at MaiBot startup:

::: code-group

```python [Python ~vscode-icons:file-type-python~]
tool_registry.register_provider(MCPToolProvider(manager))
```

:::

After that, the Maisaka planner can see and use these MCP tools exactly like built-in tools.

### Tool Invocation Flow

```
The Maisaka planner selects a tool
  → ToolRegistry looks up the corresponding Provider
  → MCPToolProvider.invoke()
    → MCPManager.call_tool_invocation()
      → Find the target server via the _tool_to_server mapping
      → MCPConnection.call_tool()
        → MCP SDK session.call_tool()
        → Return a ToolExecutionResult
```

### Name Conflicts and Protection

MCPManager has two layers of protection for tool names:

1. **Built-in tool protection**: the following names are MaiBot built-in tools and cannot be used by MCP tools:

   - **`reply`** — Reply to a message
   - **`no_action`** — Take no action this turn
   - **`stop`** — Stop
   - **`create_table`** — Create a table
   - **`list_tables`** — List tables
   - **`view_table`** — View a table

   If an MCP server exposes a tool with the same name as a built-in tool, it is skipped with a warning.

2. **Cross-server conflict detection**: if two MCP servers expose tools with the same name, only the server registered first succeeds; the rest are skipped. Registration order follows the configuration order in `bot_config.toml`.

Prompts and Resources also have conflict detection (Prompts by name, Resources by URI, ResourceTemplates by URI template).

## Client Capabilities

Besides using capabilities exposed by MCP servers, MaiBot as a client can also declare its own capabilities for servers to use in return.

### Roots (Exposing Filesystem Paths)

Allows you to expose parts of your local filesystem to MCP servers so they know which directories they may read and write.

::: code-group

```toml [Roots ~vscode-icons:file-type-toml~]
[mcp.client.roots]
enable = true

[[mcp.client.roots.items]]
enabled = true
uri = "file:///home/mai/data"
name = "MaiBot's data directory"
```

:::

Typical scenario: when connecting a filesystem MCP server (e.g. `@modelcontextprotocol/server-filesystem`), enabling Roots lets the server know where your data directory is and operate directly on files under it.

### Sampling (LLM Call Bridging)

Allows MCP servers to **ask MaiBot to call the LLM** in return to complete certain tasks. This is an advanced bidirectional capability implemented through `MCPHostLLMBridge`:

```
The MCP server initiates a Sampling request
  → MCPConnection receives the sampling_callback
    → MCPHostLLMBridge.handle_sampling_request()
      → Convert MCP message format to the internal Message format
      → Call the configured model task via LLMServiceClient
      → Convert the response back to an MCP CreateMessageResult
```

::: code-group

```toml [Sampling ~vscode-icons:file-type-toml~]
[mcp.client.sampling]
enable = true
task_name = "planner"     # Model task name used when performing Sampling
tool_support = true       # Allow continued tool use during Sampling
```

:::

::: warning ⚠️ Sampling Consumes Tokens
Enabling Sampling means MCP servers can trigger MaiBot's model calls, which incurs extra API costs. Make sure `task_name` points to a properly configured model task.
:::

### Elicitation

Allows MCP servers to request the user to fill in a form or open a URL in a browser. The UI layer is not fully implemented yet, but the capability declaration is reserved at the protocol level.

::: code-group

```toml [Elicitation ~vscode-icons:file-type-toml~]
[mcp.client.elicitation]
enable = true
allow_form = true   # Allow form mode
allow_url = false   # Allow URL mode
```

:::

## Content Types of Tool Results

The results returned by MCP tools can contain multiple content types, all handled uniformly by MaiBot:

- **`text`** — Plain-text results, the most common form
- **`image`** — Base64-encoded images (PNG, JPEG, WebP, GIF supported)
- **`audio`** — Audio data
- **`resource_link`** — A reference to an MCP resource (contains URI and description)
- **`resource`** — Embedded resource content (text or binary data)

A single tool invocation can return multiple content items (e.g. text explanation plus a screenshot at once), and MaiBot combines them before passing them to Maisaka.

## Prerequisites

MCP functionality depends on the `mcp` Python package, which is an **optional dependency** — if you don't use MCP, you don't need to install it.

If MaiBot detects configured MCP servers but the `mcp` package is not installed, it prints a hint at startup:

```
⚠️ MCP config detected but the mcp SDK is not installed, please run: pip install mcp
```

Installation:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install mcp
```

:::

::: tip MaiBot Runs Fine Without MCP
Even with no MCP configuration or without the `mcp` package installed, MaiBot runs normally — MCP is a fully optional enhancement.
:::

## Configuration Examples

The following are real-world MCP server configuration examples. See [MCP Configuration](../configuration/mcp-config.md) for the full field reference.

### Playwright Browser Automation

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

After connecting, Maisaka can use Playwright's browser automation tools (navigating webpages, taking screenshots, clicking elements, etc.).

### Filesystem Server (with Roots)

::: code-group

```toml [Filesystem ~vscode-icons:file-type-toml~]
[mcp]
enable = true

[mcp.client.roots]
enable = true

[[mcp.client.roots.items]]
enabled = true
uri = "file:///home/mai/data"
name = "Data directory"

[[mcp.servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/home/mai/data"]
```

:::

Through the Roots capability, the filesystem server knows which directory ranges MaiBot allows it to access.

### GitHub Server (with Token)

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

The GitHub MCP server expects a Personal Access Token passed via environment variables.

### Remote HTTP Server (Bearer Auth)

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

## Troubleshooting

### Check the Startup Log

MaiBot prints the connection status of every MCP server at startup. On success:

```
✓ MCP server 'playwright' connected (Tools 12 / Prompts 0 / Resources 0 / Templates 0)
```

On failure, an error message is printed:

```
⚠️ MCP server 'xxx' failed to connect: <error details>
```

### Common Issues

- **`⚠️ MCP config detected but the mcp SDK is not installed`** — The `mcp` Python package is missing → run `pip install mcp`
- **A tool with a name conflict is skipped** — The MCP tool shares a name with a built-in tool or another server's tool → check the conflict warning in the logs and adjust the server configuration
- **stdio server fails to start** — The `command` path is wrong or the command doesn't exist → confirm the command is available in your environment; `uvx` is recommended
- **Environment variables not taking effect** — The `env` config format is wrong → confirm you use the `{ KEY = "value" }` format
- **Remote server connection timeout** — Network issues or unreachable server → check the network connection and increase `http_timeout_seconds`
- **Bearer Token authentication failure** — Invalid or expired token → obtain a new token and update the configuration

### Verifying an MCP Server Independently

Before connecting to MaiBot, you can verify an MCP server works on its own using the tool bundled with the `mcp` SDK:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
mcp inspect uvx @playwright/mcp
```

:::

This helps rule out issues outside MaiBot.

## Related Documentation

- [MCP Configuration](../configuration/mcp-config.md) — Full TOML configuration field reference
- [Bot Configuration Overview](../configuration/bot-config.md) — Global configuration reference
- [Maisaka Reasoning Engine](./maisaka-reasoning.md) — Learn how MCP tools participate in reasoning and planning
