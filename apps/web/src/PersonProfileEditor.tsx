/** 人物资料管理区：手动条目、同一渲染器的后端预览和重启生效提示。 */
import {
  manualPersonProfileSectionsSchema,
  personProfileMetadataSchema,
  type ManualPersonProfileSections,
  type PersonProfileMetadata,
  type PersonProfileSectionKey,
  type PersonProfileView,
} from "@kaguya/schema";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, FieldMessage, StatusBadge } from "./components/ui.js";
import {
  getPersonProfile,
  previewPersonProfile,
  savePersonProfile,
} from "./person-profile-api.js";

const sections: {
  key: PersonProfileSectionKey;
  label: string;
  help: string;
}[] = [
  {
    key: "identity",
    label: "身份设定",
    help: "对方如何介绍自己，或稳定的身份背景；预览取前 4 条。",
  },
  {
    key: "relationship",
    label: "关系设定",
    help: "与 Kaguya 的已知关系；预览取前 4 条。",
  },
  {
    key: "stableFacts",
    label: "稳定事实",
    help: "长期有效、可用于理解对方的事实；预览取前 6 条。",
  },
  {
    key: "preferences",
    label: "互动偏好",
    help: "对方明确表达过的交流方式偏好；预览取前 5 条。",
  },
  {
    key: "recentInteractions",
    label: "近期互动",
    help: "近期值得延续的话题或事件；预览取前 2 条。",
  },
  {
    key: "uncertainNotes",
    label: "待确认事项",
    help: "仅在其他资料为空时进入 prompt，取首条。",
  },
];

export function PersonProfileEditor({
  token,
  personInformationId,
  onDirtyChange,
}: {
  token: string;
  personInformationId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<PersonProfileView>();
  const [draft, setDraft] = useState<ManualPersonProfileSections>();
  const [metadata, setMetadata] = useState<PersonProfileMetadata>();
  const [preview, setPreview] = useState("");
  const [previewName, setPreviewName] = useState("");
  const [previewFor, setPreviewFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty =
    !!saved &&
    !!draft &&
    !!metadata &&
    (JSON.stringify(draft) !== JSON.stringify(saved.sections) ||
      JSON.stringify(metadata) !== JSON.stringify(saved.metadata));
  const valid =
    !!draft &&
    !!metadata &&
    manualPersonProfileSectionsSchema.safeParse(draft).success &&
    personProfileMetadataSchema.safeParse(metadata).success;
  const draftKey = JSON.stringify([draft, metadata]);

  useEffect(() => {
    const controller = new AbortController();
    setSaved(undefined);
    setDraft(undefined);
    setMetadata(undefined);
    setPreview("");
    setPreviewName("");
    setPreviewFor("");
    setError("");
    getPersonProfile(token, personInformationId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSaved(value);
        setDraft(value.sections as ManualPersonProfileSections);
        setMetadata(value.metadata);
        setPreview(value.preview);
        setPreviewName(value.previewName);
        setPreviewFor(JSON.stringify([value.sections, value.metadata]));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    return () => controller.abort();
  }, [token, personInformationId]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!draft || !metadata || !saved || !dirty || !valid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewPersonProfile(
        token,
        personInformationId,
        draft,
        metadata,
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) {
            setPreview(value.preview);
            setPreviewName(value.previewName);
            setPreviewFor(draftKey);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setPreview("预览暂不可用。");
            setPreviewFor(draftKey);
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    token,
    personInformationId,
    draft,
    metadata,
    saved,
    dirty,
    valid,
    draftKey,
  ]);

  const update = (
    key: PersonProfileSectionKey,
    entries: ManualPersonProfileSections[PersonProfileSectionKey],
  ) => {
    setDraft((current) => (current ? { ...current, [key]: entries } : current));
    setNotice("");
  };
  const move = (key: PersonProfileSectionKey, index: number, delta: number) => {
    const next = [...draft![key]];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    update(key, next);
  };
  const save = async () => {
    if (!saved || !draft || !metadata || !valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await savePersonProfile(
        token,
        personInformationId,
        saved.revision,
        draft,
        metadata,
      );
      setSaved(next);
      setDraft(next.sections as ManualPersonProfileSections);
      setMetadata(next.metadata);
      setPreview(next.preview);
      setPreviewName(next.previewName);
      setPreviewFor(JSON.stringify([next.sections, next.metadata]));
      setNotice("已保存。请完整重启 Kaguya Server 后生效。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="person-profile-editor" aria-label="人物画像编辑">
      <header>
        <div>
          <h4>人物画像</h4>
          <p>按稳定人物 ID 保存；同一画像用于私聊和群聊。</p>
        </div>
        {saved && (
          <StatusBadge
            tone={dirty || saved.restartRequired ? "warning" : "success"}
          >
            {dirty
              ? "有未保存修改"
              : saved.restartRequired
                ? "待重启生效"
                : "已生效"}
          </StatusBadge>
        )}
      </header>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      {!draft || !metadata ? (
        !error && <FieldMessage>正在读取人物画像…</FieldMessage>
      ) : (
        <>
          <section className="person-profile-basics" aria-label="称呼">
            <div className="person-profile-section-heading">
              <div>
                <h5>称呼</h5>
                <p>主称呼用于人物目录和详情标题；别名仅手动维护。</p>
              </div>
            </div>
            <div className="person-profile-name-state">
              <label>
                <span>主称呼</span>
                <input
                  value={metadata.primaryName ?? ""}
                  maxLength={100}
                  placeholder="留空则使用首次平台昵称"
                  disabled={busy}
                  onChange={(event) =>
                    setMetadata({
                      ...metadata,
                      primaryName: event.target.value || null,
                    })
                  }
                />
              </label>
              <label>
                <span>认识状态</span>
                <select
                  value={metadata.knownStatus}
                  disabled={busy}
                  onChange={(event) =>
                    setMetadata({
                      ...metadata,
                      knownStatus: event.target
                        .value as PersonProfileMetadata["knownStatus"],
                    })
                  }
                >
                  <option value="unset">未设置</option>
                  <option value="known">已认识</option>
                  <option value="unknown">未认识</option>
                </select>
              </label>
            </div>
            <label>
              <span>名称原因</span>
              <textarea
                value={metadata.nameReason}
                maxLength={500}
                rows={2}
                disabled={busy}
                placeholder="可选；仅用于管理，不进入 prompt"
                onChange={(event) =>
                  setMetadata({
                    ...metadata,
                    nameReason: event.target.value,
                  })
                }
              />
            </label>
            <div className="person-profile-aliases">
              <div className="person-profile-section-heading">
                <div>
                  <h5>别名</h5>
                  <p>手动维护，最多 8 个；群名片不会自动成为别名。</p>
                </div>
                <Button
                  disabled={busy || metadata.aliases.length >= 8}
                  onClick={() =>
                    setMetadata({
                      ...metadata,
                      aliases: [
                        ...metadata.aliases,
                        {
                          id: crypto.randomUUID(),
                          text: "",
                          source: "manual",
                          evidenceInformationIds: [],
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} aria-hidden="true" /> 添加别名
                </Button>
              </div>
              {metadata.aliases.length === 0 ? (
                <p className="person-profile-empty">尚无别名</p>
              ) : (
                <ul>
                  {metadata.aliases.map((alias, index) => (
                    <li key={alias.id}>
                      <input
                        aria-label={`别名 ${index + 1}`}
                        value={alias.text}
                        maxLength={100}
                        disabled={busy}
                        onChange={(event) =>
                          setMetadata({
                            ...metadata,
                            aliases: metadata.aliases.map((item) =>
                              item.id === alias.id
                                ? { ...item, text: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        aria-label={`删除别名 ${index + 1}`}
                        disabled={busy}
                        onClick={() =>
                          setMetadata({
                            ...metadata,
                            aliases: metadata.aliases.filter(
                              (item) => item.id !== alias.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="person-profile-active-name">
              当前生效：{saved?.activeName} · 认识状态：
              {saved?.activeKnownStatus === "known"
                ? "已认识"
                : saved?.activeKnownStatus === "unknown"
                  ? "未认识"
                  : "未设置"}
            </p>
          </section>
          <div className="person-profile-sections">
            {sections.map(({ key, label, help }) => (
              <section key={key} className="person-profile-section">
                <div className="person-profile-section-heading">
                  <div>
                    <h5>{label}</h5>
                    <p>{help}</p>
                  </div>
                  <Button
                    disabled={draft[key].length >= 20 || busy}
                    onClick={() =>
                      update(key, [
                        ...draft[key],
                        {
                          id: crypto.randomUUID(),
                          text: "",
                          source: "manual",
                          evidenceInformationIds: [],
                        },
                      ])
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> 添加
                  </Button>
                </div>
                {draft[key].length === 0 ? (
                  <p className="person-profile-empty">尚无条目</p>
                ) : (
                  <ul>
                    {draft[key].map((entry, index) => (
                      <li key={entry.id}>
                        <label>
                          <span>
                            {label} {index + 1} · 手动
                          </span>
                          <textarea
                            value={entry.text}
                            maxLength={500}
                            rows={2}
                            disabled={busy}
                            onChange={(event) =>
                              update(
                                key,
                                draft[key].map((item) =>
                                  item.id === entry.id
                                    ? { ...item, text: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <div className="person-profile-row-actions">
                          <button
                            type="button"
                            aria-label={`上移${label} ${index + 1}`}
                            disabled={busy || index === 0}
                            onClick={() => move(key, index, -1)}
                          >
                            <ArrowUp size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`下移${label} ${index + 1}`}
                            disabled={busy || index === draft[key].length - 1}
                            onClick={() => move(key, index, 1)}
                          >
                            <ArrowDown size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`删除${label} ${index + 1}`}
                            disabled={busy}
                            onClick={() =>
                              update(
                                key,
                                draft[key].filter(
                                  (item) => item.id !== entry.id,
                                ),
                              )
                            }
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          <div className="person-profile-actions">
            <span>
              版本 {saved?.revision ?? 0}
              {dirty ? " · 草稿" : ""}
            </span>
            <Button
              variant="primary"
              disabled={!dirty || !valid || busy}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存人物画像"}
            </Button>
          </div>
          {dirty && !valid && (
            <FieldMessage tone="error">
              请填写新增内容，检查主称呼与别名是否重复；画像条目最多 500 字。
            </FieldMessage>
          )}
          {notice && <FieldMessage tone="success">{notice}</FieldMessage>}
          <section className="person-profile-preview">
            <h5>重启后 prompt 区块预览</h5>
            <p>
              展示当前草稿经长度限制后的内容；保存并重启后用于 Light 和
              Heavy。
            </p>
            <p>
              重启后名称：{previewFor === draftKey ? previewName : "正在更新…"}
            </p>
            <pre>
              {dirty && !valid
                ? "完成条目后显示预览。"
                : previewFor !== draftKey
                  ? "正在更新预览…"
                  : preview || "暂无可加入 prompt 的资料。"}
            </pre>
          </section>
        </>
      )}
      <aside className="person-profile-memory">
        <h5>从 Memory 提取人物资料</h5>
        <p>
          自动提取尚未接入。当前条目均为手动维护；以后会在这里呈现带来源证据的提取结果。
        </p>
      </aside>
    </section>
  );
}
