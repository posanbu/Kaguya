---
title: Manifest
---
# Manifest System

Every MaiBot plugin must include a `_manifest.json` file in its root directory to declare the plugin's metadata, version compatibility, dependencies, and capability requirements. The `ManifestValidator` on the Host side strictly validates this file before loading.

::: tip Plugin metadata and runtime configuration
- `_manifest.json`: Declares the plugin ID, version, dependencies, and capabilities and is validated and managed by the Host
- `config_model` in `plugin.py`: Declares the configuration structure, defaults, and WebUI metadata
- `config.toml`: Stores the current installation's runtime configuration and is generated and maintained by the Runner from `config_model`
:::

## _manifest.json Structure

Below is a complete Manifest example:

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{
  "manifest_version": 2,
  "id": "com.example.my-plugin",
  "version": "1.0.0",
  "name": "My Plugin",
  "description": "An example plugin",
  "author": {
    "name": "Developer",
    "url": "https://github.com/developer"
  },
  "license": "MIT",
  "urls": {
    "repository": "https://github.com/developer/my-plugin",
    "homepage": "https://example.com",
    "documentation": "https://docs.example.com",
    "issues": "https://github.com/developer/my-plugin/issues"
  },
  "host_application": {
    "min_version": "1.0.0",
    "max_version": "1.99.99"
  },
  "sdk": {
    "min_version": "1.0.0",
    "max_version": "2.99.99"
  },
  "dependencies": [],
  "plugin_type": "tool",
  "display": {
    "icon": {
      "type": "lucide",
      "value": "wrench"
    }
  },
  "capabilities": ["send_message"],
  "i18n": {
    "default_locale": "zh-CN",
    "locales_path": "i18n",
    "supported_locales": ["zh-CN", "en-US"]
  }
}
```

:::

## Required Fields

- **`manifest_version`** `2` — Manifest protocol version, currently fixed at `2`
- **`id`** `string` — Unique plugin identifier, formatted as lowercase letters/numbers, separated by dots or hyphens (e.g., `com.author.plugin`)
- **`version`** `string` — Plugin version number, must be a strict three-part semantic version (e.g., `1.0.0`)
- **`name`** `string` — Plugin display name
- **`description`** `string` — Plugin description
- **`author`** `object` — Plugin author information, containing `name` (author name) and `url` (author homepage, must be an HTTP/HTTPS URL)
- **`license`** `string` — Plugin license
- **`urls`** `object` — Collection of plugin-related links (see below)
- **`host_application`** `object` — Host compatibility range (see below)
- **`sdk`** `object` — SDK compatibility range (see below)
- **`capabilities`** `string[]` — List of capability requests declared by the plugin, empty values are not allowed
- **`i18n`** `object` — Internationalization configuration (see below)

## Optional Fields

### plugin_type Plugin Type

`plugin_type` is used to declare the primary role of the plugin, for WebUI display, filtering, and default icon selection. This field is optional and does not require upgrading `manifest_version`; if omitted, it defaults to `extension`.

Possible values:

- `adapter` — Message platform or protocol adapter
- `tool` — Tools, commands, or model-callable capabilities
- `provider` — LLM, TTS, API, or other service providers
- `management` — Management, permissions, group administration, or backend plugins
- `data` — Statistics, memory, knowledge base, import/export, and other data-related plugins
- `media` — Image, voice, video, emoji, and other media processing
- `game` — Games or entertainment interactions
- `integration` — External platforms, search, Webhooks, and other integrations
- `extension` — General extensions
- `other` — Other

### display Display Metadata

`display.icon` is used to declare the plugin icon. This field only affects WebUI display and does not participate in plugin runtime behavior.

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{
  "display": {
    "icon": {
      "type": "local",
      "value": "assets/icon.png",
      "fallback": "package",
      "background": "#1f2937"
    }
  }
}
```

:::

- `type`: `lucide`, `emoji`, or `local`
- `value`: Icon value. `lucide` uses the icon name, `emoji` uses a single emoji or short text, `local` uses a relative path within the plugin directory
- `fallback`: Optional, the lucide icon name to use if the icon fails to load
- `background`: Optional, the icon background color in `#RRGGBB` format

Online URLs are not allowed as plugin icons. Local icons only support `.png`, `.jpg`, `.jpeg`, `.webp`, and `.svg`. Paths must be within the plugin directory; absolute paths, `..`, or symbolic links are not permitted.

### urls Link Collection

- **`repository`** · Required — Plugin repository URL, must be an HTTP/HTTPS URL
- **`homepage`** · Optional — Plugin homepage URL
- **`documentation`** · Optional — Plugin documentation URL
- **`issues`** · Optional — Plugin issue reporting URL

### host_application / sdk Version Range

Both share the same structure, declaring a closed interval:

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{
  "min_version": "1.0.0",
  "max_version": "1.99.99"
}
```

:::

- `min_version`: Minimum allowed version (inclusive)
- `max_version`: Maximum allowed version (inclusive)
- Both must be strict three-part semantic version numbers (`X.Y.Z`)
- `min_version` cannot be greater than `max_version`

The host will verify during the handshake phase whether the current version falls within the declared range. If incompatible, the plugin will be prevented from loading.

### i18n Internationalization Configuration

- **`default_locale`** · Required — Default language code (e.g., `zh-CN`)
- **`locales_path`** · Optional — Path to the language resource files directory
- **`supported_locales`** · Optional — List of supported languages; must not contain empty values or duplicates. If non-empty, `default_locale` must exist in this list

### llm_providers LLM Provider Declaration

Declares the LLM Provider capabilities provided by the plugin, for proxy invocation by other plugins via `ctx.llm`.

- **`client_type`** · Required — Unique identifier for the Provider, must exactly match the value declared in the `@LLMProvider` decorator
- **`name`** · Required — Display name for the Provider
- **`description`** · Optional — Functional description of the Provider
- **`version`** · Optional · Default `"1.0.0"` — Version number of the Provider

::: warning Dual Declaration Requirement
The `llm_providers` field and the `@LLMProvider` decorator must both be declared, and `client_type` must match exactly. If declared in only one place, or if one is missing or inconsistent, the plugin will be prevented from loading.
:::

::: danger Conflict Loading Policy
If two plugins declare the same `client_type`, **both plugins will be prevented from loading**. Please use a unique prefix (e.g., `com.example.my-provider`) when designing Providers to avoid conflicts.
:::

```json
{
  "llm_providers": [
    {
      "client_type": "my_custom_llm",
      "name": "My Custom LLM",
      "description": "A custom LLM provider",
      "version": "1.0.0"
    }
  ]
}
```

## Dependency Declaration

The `dependencies` array supports two types of dependencies, distinguished by the `type` field:

### Plugin-Level Dependencies

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{
  "type": "plugin",
  "id": "com.example.other-plugin",
  "version_spec": ">=1.0.0,<2.0.0"
}
```

:::

- `id`: The ID of the dependent plugin, following the same formatting rules as plugin IDs
- `version_spec`: Version constraint expression, using PEP 440 style (e.g., `>=1.0.0`, `~=1.0`)
- Circular dependencies or dependencies on oneself are not allowed
- Declaring the same plugin dependency multiple times is not allowed

### Python Package Dependencies

::: code-group

```json [JSON ~vscode-icons:file-type-json~]
{
  "type": "python_package",
  "name": "httpx",
  "version_spec": ">=0.24.0"
}
```

:::

- `name`: Python package name; only letters, numbers, dots, underscores, and hyphens are allowed
- `version_spec`: Version constraint expression

### Dependency Resolution Process

`PluginDependencyPipeline` performs dependency analysis uniformly on the Host side:

1. **Scanning**: Collect `_manifest.json` from all plugins
2. **Host Conflict Detection**: If a plugin's Python package dependency has no intersection with the main program's dependency constraints, loading is blocked
3. **Inter-Plugin Conflict Detection**: If multiple plugins have mutually exclusive version constraints for the same Python package, all are blocked from loading
4. **Automatic Installation**: For missing Python dependencies of loadable plugins, `uv pip install` is used preferentially, falling back to `pip install`
5. **Topological Sorting**: Determine the Runner startup order based on cross-Supervisor dependency relationships; circular dependencies will be rejected

## Validation Rules

The Manifest Validator (`ManifestValidator`) adopts Pydantic strict mode. The main validation rules include:

- **No Extra Fields**: Fields not declared in `_manifest.json` are not allowed.
- **ID Format**: Must match `^[a-z0-9]+(?:[.-][a-z0-9]+)+$` (e.g., `com.example.my-plugin`).
- **Version Format**: Must be a three-part `X.Y.Z` format.
- **URL Format**: Must start with `http://` or `https://`.
- **No Self-Dependency**: The plugin cannot depend on itself in `dependencies`.
- **No Duplicate Dependencies**: Each plugin/package name can only be declared once.
