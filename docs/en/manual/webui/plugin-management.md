---
title: Installing and Managing Plugins
---
# Install and Manage Plugins

Plugins are like installing "Apps" for MaiBot, giving it more capabilities!

## What is a Plugin?

Plugins are extensions for MaiBot, such as:

- 🎮 **Game Plugins** - Can play games with users
- 🎨 **Drawing Plugins** - Can generate images
- 🎵 **Music Plugins** - Can play music
- 🌤️ **Weather Plugins** - Can check weather forecasts
- 📚 **Learning Plugins** - Can teach knowledge

## Install Plugins

### Method 1: Online Installation (Recommended)

1. Open the WebUI and click "Plugin Management"
2. Click the "Install Plugin" button
3. Enter the plugin address (GitHub link)
4. Click "Install" and wait for completion

**Example Address**:
```
https://github.com/author/plugin-name
```

### Method 2: Git URL Installation

1. Obtain the plugin's Git repository address (GitHub, etc.)
2. Click "Install Plugin" on the plugin management page
3. Enter the Git repository URL
4. Click "Install" and wait for completion

> Note: Currently, only installation via Git repository URL is supported; local file upload is not supported

## Manage Installed Plugins

### View Plugins

The plugin page will display:
- 📋 **Plugin Name** and description
- 🔧 **Version Number** and author
- ✅ **Enable Status** (Green = Enabled, Gray = Disabled)
- 📖 **Usage Instructions** (Click to view)

### Enable/Disable Plugins

- Switch ON → The runtime loads the plugin
- Switch OFF → The unload lifecycle runs and the plugin stops
- This normally applies immediately without restarting all of MaiBot

### Configure Plugins

Some plugins allow custom settings:
1. Click the "Settings" button of the plugin
2. Modify configuration options
3. After saving, the runtime invokes the plugin configuration-update lifecycle

**Common Configurations**:
- API Keys (for plugins requiring external services)
- Trigger Keywords
- Feature Toggles

### Update Plugins

When a new version of a plugin is available, an update prompt will appear:
1. Click the "Update" button
2. Wait for download and installation
3. Source changes restart the plugin Supervisor and reload the plugin

### Uninstall Plugins

Unnecessary plugins can be uninstalled:
1. Click the "Uninstall" button
2. Confirm uninstallation
3. Plugin files will be deleted

⚠️ **Note**: Plugin data may be lost after uninstallation

## Actual Lifecycle and Restart Boundary

**Install** — The file watcher detects the new plugin directory. The Runner generates `config.toml` from the defaults in the plugin's `config_model`; plugins whose `enabled` default is `false` must be enabled after installation.

**Enable and disable** — The runtime loads or unloads the plugin without restarting MaiBot.

**Configuration update** — A loaded plugin receives `on_config_update`. Disabling it unloads it; enabling an unloaded plugin loads it.

**Source update** — Changes to `.py`, `plugin.py`, or `_manifest.json` restart the plugin Supervisor. The plugin is briefly unavailable, but the MaiBot core remains running.

**Uninstall** — The WebUI disables and unloads the plugin before deleting its files. Check whether the plugin stores user data in its own directory before uninstalling it.

::: warning Restart is a recovery step
Restart all of MaiBot only if the log reports that watching, loading, unloading, or a configuration callback failed. It is not a normal requirement for plugin management.
:::

## Recommended Plugins

### Essentials for Beginners
- **Welcome Plugin** - Automatically welcomes new users to the group
- **Help Plugin** - Provides command help
- **Check-in Plugin** - Daily check-in functionality

### Entertainment
- **Gacha Plugin** - Simulates various gacha pulls
- **Dice Plugin** - Dice rolling game
- **Riddle Plugin** - Riddles and brain teasers

### Utility
- **Translation Plugin** - Multi-language translation
- **Calculation Plugin** - Mathematical calculations
- **Time Plugin** - Time and date queries

## Usage Tips

### Plugin Conflicts
If plugin functions overlap or conflict:
- Only enable necessary plugins
- Contact the plugin author for updates

### Performance Optimization
Too many plugins may affect performance:
- Uninstall unused plugins promptly
- Regularly clean up unnecessary plugins
- Monitor plugin resource usage

### Security Reminders
- Only install plugins from trusted sources
- Review plugin permission requirements
- Regularly update plugin versions

## Frequently Asked Questions

**Q: What should I do if plugin installation fails?**
A: Check your network connection, confirm the plugin address is correct, and review error messages

**Q: The plugin is not working?**
A: Confirm the plugin is enabled, check if the configuration is correct, and review MaiBot logs

**Q: Where can I find plugins?**
A: Search "MaiBot Plugins" on GitHub, or join the community for recommendations

**Q: Can I develop my own plugins?**
A: Of course! There are development documentation and example code available; even beginners can learn

## Get Help

- Usage instructions are available on the plugin page
- Review the plugin's README documentation
- Join the MaiBot discussion group to ask questions
- Submit issues on GitHub
