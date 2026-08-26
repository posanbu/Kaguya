---
title: 🖥️ WebUI Admin Panel
---

# 🖥️ WebUI Management Panel

Manage your bot right through your browser!

## First Time Use

### Get the Login Password

When starting MaiBot for the first time, the console will display a password (Token):

```
WebUI Access Token: a1b2c3d4...
Please use this Token to log in to the WebUI
```

The first value shown is a temporary Token for the current startup. After signing in, the setup wizard requires you to set a secure persistent Token. A temporary Token is regenerated on the next startup.

### Login Steps

1. Open your browser and visit `http://localhost:8001` (default address)
2. Enter the password shown in the console
3. On first sign-in, set a persistent Token as instructed and sign in again with the new Token
4. Complete initial setup to enter the management panel

## What Can You Do?

WebUI makes it easy to manage MaiBot:

- ⚙️ **Change Configuration** - Modify settings with a few clicks, no need to edit files
- 🧠 **Manage Memory** - View, edit, and delete the bot's memories
- 🔌 **Install Plugins** - Install and manage various functional plugins
- 📊 **View Statistics** - Check chat logs and usage data

## Basic Settings

You can change the WebUI settings in `bot_config.toml`:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[webui]
enabled = true                # Whether to enable WebUI
host = ["127.0.0.1", "::1"]  # Bind address list
port = 8001                   # Port number
mode = "production"           # Running mode: development or production
webui_style = 1               # UI style
anti_crawler_mode = "basic"   # Anti-crawler mode: false / strict / loose / basic
allowed_ips = "127.0.0.1"     # IP whitelist (comma-separated)
```

:::

- Change `host` to `["0.0.0.0", "::"]` to listen on all IPv4/IPv6 interfaces; also configure firewall rules, access restrictions, and HTTPS
- `port` can be changed to another number to avoid conflicts

## Forgot Your Password?

If you can still sign in, regenerate or update the Token in System Settings. If you can no longer sign in:

1. Shut down MaiBot
2. Delete the `data/webui.json` file
3. Restart MaiBot, use the new temporary Token shown in the console, and set a new persistent Token

## Security Reminders

- Do not share your password with others
- Prefer HTTPS or a trusted private network for remote access; changing the port alone is not access control
- Regenerate the Token immediately if you suspect it has leaked

## More Features

- [Configuration Management](./config-management.md) - Change configurations in the browser
- [Memory Management](./memory-management.md) - View and manage memories
- [Plugin Management](./plugin-management.md) - Install and manage plugins
- [Chat Logs](./chat-stats.md) - View chat statistics
