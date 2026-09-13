/**
 * 功能概述：模块详情页的全局 settings 表单，控件完全由模块字段元数据生成。
 * 主要职责：ModuleSettingsSection 读取实例；InstanceEditor 保留失败草稿并发送带 revision 的完整替换。
 * 代码库关系：通过 #152 的 section 插槽接收 definitionId/token；独立客户端复用共享响应 schema。
 * 输入输出与副作用：保存只写磁盘并提示显式应用；切换模块取消读取，不自动应用配置。
 */
import { useEffect, useState } from "react";
import type {
  ModuleSettingsField,
  ModuleSettingsInstance,
  ModuleSettingsView,
} from "@kaguya/schema";
import type { ModuleEditorProps } from "./ModulePages.js";
import { useNavigationGuard } from "./components/AppShell.js";
import {
  requestModuleSettings,
  ModuleSettingsRequestError,
} from "./module-settings-api.js";
export function ModuleSettingsSection(props: ModuleEditorProps) {
  return (
    <SettingsLoader key={`${props.definitionId}:${props.token}`} {...props} />
  );
}
function SettingsLoader({ definitionId, token }: ModuleEditorProps) {
  const [view, setView] = useState<ModuleSettingsView>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void requestModuleSettings(
      token,
      definitionId,
      undefined,
      controller.signal,
    ).then(setView, () => {
      if (!controller.signal.aborted)
        setError("无法读取全局模块配置，请检查管理权限或刷新页面。");
    });
    return () => controller.abort();
  }, [definitionId, token]);
  return (
    <div>
      <p>
        全局模块配置：不随顶栏 Profile
        切换。保存后需要在生效管理中显式应用；运行实例不会立即改变。
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !view ? (
        <p>正在读取配置…</p>
      ) : (
        <>
          {view.instances.length === 0 && (
            <p>此模块没有持久化配置实例，无需在此配置。</p>
          )}
          {view.instances.map((instance) => (
            <InstanceEditor
              key={instance.instanceId}
              instance={instance}
              fields={view.fields}
              token={token}
              definitionId={definitionId}
            />
          ))}
        </>
      )}
    </div>
  );
}
function InstanceEditor({
  instance,
  fields,
  token,
  definitionId,
}: ModuleEditorProps & {
  instance: ModuleSettingsInstance;
  fields: ModuleSettingsField[];
}) {
  const [saved, setSaved] = useState(instance);
  const [values, setValues] = useState<Record<string, unknown>>(
    instance.settings,
  );
  const [enabled, setEnabled] = useState(instance.enabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<
    readonly { path: string; message: string }[]
  >([]);
  const dirty =
    enabled !== saved.enabled ||
    JSON.stringify(values) !== JSON.stringify(saved.settings);
  useNavigationGuard(
    () => !dirty || window.confirm("模块配置尚未保存，确定离开吗？"),
  );
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const save = async () => {
    setBusy(true);
    setNotice("");
    setErrors([]);
    try {
      const result = await requestModuleSettings(token, definitionId, {
        instanceId: saved.instanceId,
        replacement: { revision: saved.revision, enabled, settings: values },
      });
      const next = result.instances.find(
        (i) => i.instanceId === saved.instanceId,
      )!;
      setSaved(next);
      setValues(next.settings);
      setEnabled(next.enabled);
      setNotice(
        "全局配置已保存。请前往生效管理，显式应用当前配置；运行实例尚未改变。",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "保存失败，输入已保留。",
      );
      setErrors(
        error instanceof ModuleSettingsRequestError ? error.fields : [],
      );
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (
      dirty &&
      !window.confirm("重新读取会放弃当前未保存的输入，确定继续吗？")
    )
      return;
    setBusy(true);
    try {
      const result = await requestModuleSettings(token, definitionId);
      const next = result.instances.find(
        (i) => i.instanceId === saved.instanceId,
      )!;
      setSaved(next);
      setValues(next.settings);
      setEnabled(next.enabled);
      setNotice("");
      setErrors([]);
    } catch {
      setNotice("重新读取失败，当前输入已保留。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h4>{saved.instanceId}</h4>
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          配置启用状态
        </label>
        {fields.length === 0 && <p>无需配置 settings 字段。</p>}
        {fields.map((field) => (
          <div key={field.key}>
            <label>
              {field.title}
              <FieldControl
                field={field}
                value={values[field.key]}
                onChange={(value) =>
                  setValues({ ...values, [field.key]: value })
                }
              />
            </label>
            <p>
              {field.description}
              {field.readOnly ? "（只读）" : ""}
            </p>
            <small>
              {field.default !== undefined
                ? `默认值：${JSON.stringify(field.default)}。`
                : ""}
              {field.minimum !== undefined ? `最小值：${field.minimum}。` : ""}
              {field.maximum !== undefined ? `最大值：${field.maximum}。` : ""}
            </small>
            {errors
              .filter(
                (e) =>
                  e.path === field.key || e.path.startsWith(`${field.key}.`),
              )
              .map((e, i) => (
                <p role="alert" key={i}>
                  {e.message}
                </p>
              ))}
          </div>
        ))}
        <button type="submit" disabled={!dirty}>
          保存全局配置
        </button>
        <button type="button" onClick={() => void reload()}>
          重新读取
        </button>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      {errors
        .filter((e) => !e.path)
        .map((e, i) => (
          <p role="alert" key={i}>
            {e.message}
          </p>
        ))}
    </form>
  );
}
function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ModuleSettingsField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean")
    return (
      <input
        type="checkbox"
        disabled={field.readOnly}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (field.enum)
    return (
      <select
        disabled={field.readOnly}
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {field.enum.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  if (field.type === "array")
    return (
      <textarea
        readOnly={field.readOnly}
        value={Array.isArray(value) ? value.join("\n") : ""}
        onChange={(event) => onChange(event.target.value.split("\n"))}
      />
    );
  const number = field.type === "number" || field.type === "integer";
  return (
    <input
      type={number ? "number" : "text"}
      readOnly={field.readOnly}
      required={field.required}
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      min={field.minimum}
      max={field.maximum}
      step={field.type === "integer" ? 1 : "any"}
      minLength={field.minLength}
      maxLength={field.maxLength}
      onChange={(event) =>
        onChange(
          number && event.target.value !== ""
            ? Number(event.target.value)
            : event.target.value,
        )
      }
    />
  );
}
