/**
 * 功能概述：模块详情页静态模板编辑区，明确所属、变量、组成关系和默认/本地来源。
 * 主要职责：TemplatesEditor 管理每个模板草稿；保存和恢复使用整组 revision，失败保留输入。
 * 代码库关系：#152 插槽传递 definitionId/token；客户端调用独立认证路由，无运行时渲染预览。
 * 输入输出与副作用：只写 local 覆盖，默认源码只读；成功提示重启，导航保护所有未保存草稿。
 */
import "./module-editors.css";
import { Button } from "./components/ui.js";
import { useEffect, useState } from "react";
import type { ModuleTemplatesView } from "@kaguya/schema";
import type { ModuleEditorProps } from "./ModulePages.js";
import { useNavigationGuard } from "./components/AppShell.js";
import { requestModuleTemplates } from "./module-templates-api.js";
export function ModuleTemplatesSection(props: ModuleEditorProps) {
  return (
    <TemplatesEditor key={`${props.definitionId}:${props.token}`} {...props} />
  );
}
function TemplatesEditor({ definitionId, token }: ModuleEditorProps) {
  const [view, setView] = useState<ModuleTemplatesView>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = !!view?.templates.some(
    (t) => drafts[t.templateId] !== t.content,
  );
  useNavigationGuard(
    () => !dirty || window.confirm("模板尚未保存，确定离开吗？"),
  );
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    void requestModuleTemplates(
      token,
      definitionId,
      undefined,
      controller.signal,
    ).then(
      (result) => {
        setView(result);
        setDrafts(
          Object.fromEntries(
            result.templates.map((t) => [t.templateId, t.content]),
          ),
        );
      },
      () => {
        if (!controller.signal.aborted)
          setError("无法读取模板，请检查管理权限或服务器状态。");
      },
    );
    return () => controller.abort();
  }, [definitionId, token]);
  const change = async (templateId: string, restore = false) => {
    if (!view) return;
    if (
      restore &&
      !window.confirm("恢复默认将删除本地覆盖并放弃该模板草稿，确定继续吗？")
    )
      return;
    setBusy(true);
    setNotices((current) => ({ ...current, [templateId]: "" }));
    try {
      const result = await requestModuleTemplates(token, definitionId, {
        templateId,
        revision: view.revision,
        ...(restore
          ? { restore: true }
          : { content: drafts[templateId] ?? "" }),
      });
      setView(result);
      setDrafts((current) => ({
        ...current,
        [templateId]: result.templates.find((t) => t.templateId === templateId)!
          .content,
      }));
      setNotices((current) => ({
        ...current,
        [templateId]: restore
          ? "已恢复内置默认值。请重启服务后生效。"
          : "本地覆盖已保存。请重启服务后生效。",
      }));
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [templateId]:
          error instanceof Error ? error.message : "保存失败，输入已保留。",
      }));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (
      dirty &&
      !window.confirm("重新读取会放弃所有未保存模板输入，确定继续吗？")
    )
      return;
    setBusy(true);
    try {
      const result = await requestModuleTemplates(token, definitionId);
      setView(result);
      setDrafts(
        Object.fromEntries(
          result.templates.map((t) => [t.templateId, t.content]),
        ),
      );
      setNotices({});
      setError("");
    } catch {
      setError("重新读取失败，输入已保留。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p>
        这里只编辑未渲染的模板源码。保存创建全局本地覆盖，不修改内置默认值；保存或恢复后请重启服务。
      </p>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p>正在读取模板…</p>}
      {view?.templates.length === 0 && (
        <p>此模块未声明可编辑的 Prompt 模板。</p>
      )}
      {view && view.templates.length > 0 && (
        <Button type="button" disabled={busy} onClick={() => void reload()}>
          重新读取模板组
        </Button>
      )}
      {view?.templates.map((template) => (
        <form
          className="module-editor"
          key={template.templateId}
          onSubmit={(event) => {
            event.preventDefault();
            void change(template.templateId);
          }}
        >
          <h4>{template.displayName}</h4>
          <p>{template.description}</p>
          <p>
            当前来源：{template.source === "local" ? "本地覆盖" : "内置默认值"}
          </p>
          <p>允许变量：{template.allowedVariables.join("、") || "无"}</p>
          <p>
            允许静态 partial：{template.allowedPartials.join("、") || "无"}
            ；允许块 helper：each、if、unless。
          </p>
          <p>
            组成关系：
            {template.composes
              .map(
                (id) =>
                  view.templates.find((t) => t.templateId === id)
                    ?.displayName ?? id,
              )
              .join("、") || "独立模板"}
          </p>
          <label>
            {template.displayName}源码
            <textarea
              rows={12}
              spellCheck={false}
              disabled={busy}
              value={drafts[template.templateId] ?? ""}
              onChange={(event) =>
                setDrafts({
                  ...drafts,
                  [template.templateId]: event.target.value,
                })
              }
            />
          </label>
          <Button
            type="submit"
            disabled={busy || drafts[template.templateId] === template.content}
          >
            保存本地覆盖
          </Button>
          <Button
            type="button"
            disabled={busy || template.source !== "local"}
            onClick={() => void change(template.templateId, true)}
          >
            恢复默认
          </Button>
          {notices[template.templateId] && (
            <p role="status">{notices[template.templateId]}</p>
          )}
        </form>
      ))}
    </div>
  );
}
