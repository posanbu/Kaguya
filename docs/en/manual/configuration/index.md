---
title: Configuration Overview
---

# Configuration Overview
## 📋 Configuration File List

MaiBot has two main configuration files, both located in the `config/` folder:

**`bot_config.toml`** — Main configuration for bot basic info, personality, chat, memory (including A_Memorix), learning, logging, etc. [View Details](./bot-config.md)
**`model_config.toml`** — AI model settings, configure the LLM used by Mai. [View Details](./model-config.md)

::: tip 💡 Tip
These configuration files will only be generated after starting MaiBot once. If you cannot find them, please start it once first.
:::

## Hot-reload Scope

MaiBot watches `bot_config.toml` and `model_config.toml`. Whether a restart is required depends on whether a setting controls runtime behavior or how a service is started.

**Applies automatically after saving** — Bot profile, personality, chat policy, reply frequency, model providers, models, and task assignments are reloaded. Model changes are used by subsequent requests. Modules with reload callbacks, including A_Memorix and emoji maintenance, also receive the update.

**Hot-reloaded by the plugin runtime** — A plugin's own `config.toml` has a separate lifecycle. The runtime watches it and calls the plugin configuration-update hook. Enabling, disabling, installing, uninstalling, and source updates normally do not require restarting all of MaiBot.

**Requires a full MaiBot restart** — WebUI enable/bind/port settings; `maim_message` bind, port, and authentication; MCP server connections; and process-level plugin-runtime bind or IPC settings are established at startup and are not rebound by a file reload.

::: tip How to tell
Check the log after saving. A successful configuration-reload or plugin-update message means the new value has taken over. Restart MaiBot when changing a listener, MCP connection, or another startup-only setting.
:::


## 🌐 WebUI Configuration

If you don't like manually editing files, MaiBot also provides a web-based configuration interface (WebUI configuration interface is built-in since 1.0.0):

- 🌐 Default address: `http://127.0.0.1:8001`
- 🖱️ Change configurations with a few mouse clicks
- 📱 Usable on both mobile and PC
