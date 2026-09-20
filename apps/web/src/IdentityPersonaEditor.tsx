import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./components/ui.js";
import {
  requestIdentityPersonaTemplate,
  type IdentityPersonaTemplateView,
  type IdentityResourceKind,
} from "./identity-persona-api.js";

const resources: readonly {
  kind: IdentityResourceKind;
  label: string;
  rows: number;
  help: string;
}[] = [
  { kind: "name", label: "Agent 名字", rows: 1, help: "主名称。" },
  {
    kind: "aliases",
    label: "Agent 别名",
    rows: 3,
    help: "每行一个；会去除空行和重复项，且不能与主名称相同。",
  },
  {
    kind: "persona",
    label: "身份、经历、性格与关系",
    rows: 5,
    help: "不放平台表达风格；平台风格由对应模块资源决定。",
  },
];

export function IdentityPersonaEditor({
  token,
  timeZoneEditor,
}: {
  readonly token: string;
  readonly timeZoneEditor: ReactNode;
}) {
  return (
    <div className="module-editor identity-persona-editor">
      <h4>工作区辉夜身份资源</h4>
      <span className="wb-sr-only">
        工作区级，影响全部 Profile；保存或恢复后重启服务生效。
      </span>
      <div className="identity-resource-grid">
        {resources.slice(0, 2).map((resource) => (
          <IdentityResourceEditor
            key={resource.kind}
            token={token}
            {...resource}
          />
        ))}
        {timeZoneEditor}
        <IdentityResourceEditor token={token} {...resources[2]!} />
      </div>
    </div>
  );
}

function IdentityResourceEditor({
  token,
  kind,
  label,
  rows,
  help,
}: {
  readonly token: string;
  readonly kind: IdentityResourceKind;
  readonly label: string;
  readonly rows: number;
  readonly help: string;
}) {
  const [view, setView] = useState<IdentityPersonaTemplateView>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    setBusy(true);
    setMessage("");
    try {
      const next = await requestIdentityPersonaTemplate(token, kind);
      setView(next);
      setDraft(next.content);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "身份资源读取失败。");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [token, kind]);
  const change = async (restore = false) => {
    if (!view) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await requestIdentityPersonaTemplate(token, kind, {
        revision: view.revision,
        ...(restore ? { restore: true } : { content: draft }),
      });
      setView(next);
      setDraft(next.content);
      setMessage("已保存。重启服务后影响全部 Profile。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "身份资源操作失败。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className={`field identity-resource identity-resource-${kind}`}>
      <span>{label}</span>
      {view && (
        <>
          <textarea
            className="persona-editor"
            rows={rows}
            spellCheck={false}
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={help}
            title={`${help} 当前来源：${view.source === "local" ? "本地覆盖" : "内置默认值"}`}
          />
          <span className="identity-resource-actions">
            <Button
              type="button"
              disabled={busy || draft === view.content}
              onClick={() => void change()}
            >
              保存
            </Button>
            <Button
              type="button"
              disabled={busy || view.source !== "local"}
              onClick={() => void change(true)}
            >
              恢复默认
            </Button>
          </span>
        </>
      )}
      {!view && !message && <span>正在读取…</span>}
      {message && <span role={view ? "status" : "alert"}>{message}</span>}
    </label>
  );
}
