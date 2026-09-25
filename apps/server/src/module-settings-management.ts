/**
 * 功能概述：对持久化模块配置提供安全读取与并发替换，不接触运行实例。
 * 主要职责：ModuleSettingsManagement 从同一 settingsSchema 导出公开字段并验证磁盘/输入；
 * replace 在配置应用共享锁中重读版本，保留隐藏字段并拒绝只读更改，原子写入现有实例。
 * 代码库关系：Server 注入 Catalog、配置目录及 configuration.exclusive；HTTP 只消费安全 DTO。
 * 输入输出与副作用：HMAC revision 防止过期覆盖，错误仅返回受信字段路径与固定提示；不调用 apply。
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  loadModuleInstanceConfigs,
  writeModuleInstanceConfig,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import {
  z,
  type ModuleSettingsField,
  type ModuleSettingsView,
  moduleSettingsReplacementSchema,
} from "@kaguya/schema";
import type { InformationModuleCatalog } from "@kaguya/sdk";
export class ModuleSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fields: readonly { path: string; message: string }[] = [],
  ) {
    super(code);
  }
}
export class ModuleSettingsManagement {
  private readonly key = randomBytes(32);
  constructor(
    private readonly options: {
      rootDir: string;
      catalog: InformationModuleCatalog;
      defaults: readonly ModuleInstanceConfig[];
      exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
      replaceFeature?: (
        current: readonly ModuleInstanceConfig[],
        next: readonly ModuleInstanceConfig[],
      ) => Promise<void>;
    },
  ) {}
  private definition(id: string) {
    const definition = this.options.catalog.definitions.find(
      (d) => d.manifest.definitionId === id,
    );
    if (!definition) throw new ModuleSettingsError(404, "module_not_found");
    return definition;
  }
  private fields(id: string): ModuleSettingsField[] {
    const json = z.toJSONSchema(
      this.definition(id).manifest.settingsSchema,
    ) as Record<string, any>;
    return Object.entries(json.properties ?? {}).flatMap(([key, value]) => {
      const field = value as Record<string, any>;
      if (field.public !== true) return [];
      if (
        !field.title ||
        !field.description ||
        !["string", "number", "integer", "boolean", "array"].includes(
          field.type,
        )
      )
        throw new ModuleSettingsError(503, "module_schema_unavailable");
      if (
        field.type === "array" &&
        !["string", "object"].includes(field.items?.type)
      )
        throw new ModuleSettingsError(503, "module_schema_unavailable");
      return [
        {
          key,
          title: field.title,
          description: field.description,
          type: field.type,
          ...(field.type === "array" ? { itemType: field.items.type } : {}),
          readOnly: field.readOnly === true,
          ...(field.secret === true ? { secret: true } : {}),
          required: (json.required ?? []).includes(key),
          ...Object.fromEntries(
            ["minimum", "maximum", "minLength", "maxLength", "enum", "default"]
              .filter((name) => field[name] !== undefined)
              .map((name) => [name, field[name]]),
          ),
        },
      ];
    });
  }
  private revision(config: ModuleInstanceConfig) {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(config))
      .digest("hex");
  }
  private async load() {
    return loadModuleInstanceConfigs({ ...this.options, initialize: false });
  }
  async get(id: string): Promise<ModuleSettingsView> {
    const definition = this.definition(id);
    const fields = this.fields(id);
    const configs = (await this.load()).filter((c) => c.definitionId === id);
    for (const config of configs)
      if (
        !definition.manifest.settingsSchema.safeParse(config.settings).success
      )
        throw new ModuleSettingsError(503, "module_configuration_invalid");
    return {
      definitionId: id,
      scope: "global",
      effect: [
        "memory.writeback",
        "memory.knowledge",
        "memory.index",
        "memory.cognition",
      ].includes(id)
        ? "immediate"
        : "explicit_apply",
      fields,
      instances: configs.map((c) => ({
        instanceId: c.instanceId,
        enabled: c.enabled,
        revision: this.revision(c),
        settings: Object.fromEntries(
          fields
            .filter((f) => !f.secret && Object.hasOwn(c.settings, f.key))
            .map((f) => [f.key, c.settings[f.key]]),
        ),
      })),
    };
  }
  async replace(
    id: string,
    instanceId: string,
    input: unknown,
  ): Promise<ModuleSettingsView> {
    return this.options.exclusive(async () => {
      const parsed = moduleSettingsReplacementSchema.safeParse(input);
      if (!parsed.success)
        throw new ModuleSettingsError(400, "invalid_module_settings");
      const definition = this.definition(id);
      const fields = this.fields(id);
      const configs = await this.load();
      const current = configs.find(
        (c) => c.definitionId === id && c.instanceId === instanceId,
      );
      if (!current)
        throw new ModuleSettingsError(404, "module_instance_not_found");
      if (parsed.data.revision !== this.revision(current))
        throw new ModuleSettingsError(409, "module_configuration_changed");
      const visible = new Set(fields.map((f) => f.key));
      if (Object.keys(parsed.data.settings).some((key) => !visible.has(key)))
        throw new ModuleSettingsError(400, "invalid_module_settings");
      const settings = { ...current.settings };
      for (const field of fields) {
        const value = parsed.data.settings[field.key];
        if (field.secret && (value === undefined || value === "")) continue;
        if (
          field.readOnly &&
          JSON.stringify(value) !== JSON.stringify(current.settings[field.key])
        )
          throw new ModuleSettingsError(400, "invalid_module_settings", [
            { path: field.key, message: "此字段为只读，请重新读取配置。" },
          ]);
        delete settings[field.key];
        if (value !== undefined) settings[field.key] = value as never;
      }
      const validation = definition.manifest.settingsSchema.safeParse(settings);
      if (!validation.success)
        throw new ModuleSettingsError(
          400,
          "invalid_module_settings",
          validation.error.issues.map((issue: { path: PropertyKey[] }) => ({
            path: visible.has(String(issue.path[0]))
              ? issue.path.map(String).join(".")
              : "",
            message: "字段值不符合模块声明的类型或约束，请检查输入。",
          })),
        );
      const replacement: ModuleInstanceConfig = {
        ...current,
        enabled: parsed.data.enabled,
        settings: validation.data,
      };
      if (
        [
          "memory.writeback",
          "memory.knowledge",
          "memory.index",
          "memory.cognition",
        ].includes(id)
      ) {
        if (replacement.enabled !== current.enabled)
          throw new ModuleSettingsError(400, "use_feature_switch");
        if (!this.options.replaceFeature)
          throw new ModuleSettingsError(503, "feature_switch_unavailable");
        await this.options.replaceFeature(
          configs,
          configs.map((config) =>
            config.instanceId === instanceId ? replacement : config,
          ),
        );
      } else await writeModuleInstanceConfig(this.options.rootDir, replacement);
      return this.get(id);
    });
  }
}
