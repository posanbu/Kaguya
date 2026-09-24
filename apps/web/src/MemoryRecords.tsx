/**
 * 功能概述：展示服务器中的全局已录入记忆，并提供定向对话修改、删除和撤销。
 * 主要职责：MemoryRecords 有界搜索/翻页并读取最新断言；RecordActions 用独立按钮传达操作，
 * 删除请求按稳定 operationId 重试，成功后更新列表；失败保留原记录，不乐观宣称已删除。
 * 代码库关系：MemoryIngestion 提供当前处理锁、刷新信号和修改回调；数据来自共享 records DTO 与真实管理 API。
 * 输入输出与副作用：不依赖本地会话列表，不持久化认证；卸载取消读取，写入成功后通知父页面刷新目标状态。
 */
import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Undo2 } from "lucide-react";
import {
  memoryIngestionRecordsSchema,
  memoryIngestionRecordSchema,
  type MemoryIngestionRecord,
} from "@kaguya/schema";
import { Button, FieldMessage } from "./components/ui.js";
import {
  requestMemoryIngestion,
  MemoryIngestionRequestError,
} from "./memory-ingestion-api.js";
export function MemoryRecords({
  token,
  revision,
  busy,
  onEdit,
  onChanged,
}: {
  token: string;
  revision: string;
  busy: boolean;
  onEdit: (record: MemoryIngestionRecord) => void;
  onChanged: (record: MemoryIngestionRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<{
    records: MemoryIngestionRecord[];
    hasMore: boolean;
  }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [changing, setChanging] = useState<string>();
  const pending = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void requestMemoryIngestion(
      token,
      `records?query=${encodeURIComponent(query)}&offset=${offset}`,
      memoryIngestionRecordsSchema,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "无法读取记忆，请刷新。",
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [token, query, offset, revision, refresh]);
  async function mutate(record: MemoryIngestionRecord) {
    if (changing || busy) return;
    const action = record.deleted ? "restore" : "delete";
    const key = `${action}:${record.claimId}`;
    const operationId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, operationId);
    setChanging(record.claimId);
    setError(undefined);
    try {
      const result = await requestMemoryIngestion(
        token,
        "records/mutate",
        memoryIngestionRecordSchema,
        { body: { operationId, claimId: record.claimId, action } },
      );
      pending.current.delete(key);
      if (!mounted.current) return;
      onChanged(result);
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
      if (cause instanceof MemoryIngestionRequestError && cause.status < 500)
        pending.current.delete(key);
    } finally {
      if (mounted.current) setChanging(undefined);
    }
  }
  return (
    <aside className="ingestion-library" aria-label="已保存的记忆">
      <div className="ingestion-library-heading">
        <h2>已保存的记忆</h2>
        <Button
          onClick={() => setRefresh((value) => value + 1)}
          disabled={!!changing}
        >
          刷新
        </Button>
      </div>
      <label className="ingestion-search">
        查找记忆
        <input
          type="search"
          value={query}
          maxLength={200}
          placeholder="人物或内容"
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      {loading && !data ? <FieldMessage>正在读取记忆…</FieldMessage> : null}
      {data?.records.length === 0 && !loading ? (
        <p className="ingestion-library-empty">
          {query ? "没有找到匹配的记忆。" : "还没有已保存的记忆。"}
        </p>
      ) : null}
      <ul className="ingestion-saved-records" aria-busy={loading}>
        {data?.records.map((record) => (
          <li
            key={record.claimId}
            className={record.deleted ? "is-deleted" : undefined}
          >
            <div>
              <strong>{record.subjectLabel}</strong>
              <p>
                {record.predicate}：{record.value}
              </p>
              <small>
                {record.deleted
                  ? "已删除 · 不再召回"
                  : record.sourceType === "character_setting"
                    ? "角色设定"
                    : "用户陈述"}
              </small>
              <details>
                <summary>查看来源</summary>
                <p>{record.evidenceText}</p>
              </details>
            </div>
            <RecordActions
              record={record}
              busy={busy || !!changing || loading}
              onEdit={() => onEdit(record)}
              onMutate={() => void mutate(record)}
            />
          </li>
        ))}
      </ul>
      {data && (offset > 0 || data.hasMore) ? (
        <div className="ingestion-pagination">
          <Button
            disabled={offset === 0 || loading || !!changing}
            onClick={() => setOffset((value) => Math.max(0, value - 20))}
          >
            上一页
          </Button>
          <Button
            disabled={!data.hasMore || loading || !!changing}
            onClick={() => setOffset((value) => value + 20)}
          >
            下一页
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
export function RecordActions({
  record,
  busy,
  onEdit,
  onMutate,
}: {
  record: MemoryIngestionRecord;
  busy: boolean;
  onEdit: () => void;
  onMutate: () => void;
}) {
  return (
    <div className="ingestion-record-actions">
      {record.deleted ? (
        <Button
          disabled={busy}
          onClick={onMutate}
          aria-label={`撤销删除：${record.subjectLabel} · ${record.predicate}`}
        >
          <Undo2 size={16} aria-hidden="true" />
          撤销
        </Button>
      ) : (
        <>
          <Button
            disabled={busy}
            onClick={onEdit}
            aria-label={`修改记忆：${record.subjectLabel} · ${record.predicate}`}
            title="给 Agent 发指令修改"
          >
            <Pencil size={16} aria-hidden="true" />
          </Button>
          <Button
            disabled={busy}
            onClick={onMutate}
            aria-label={`删除记忆：${record.subjectLabel} · ${record.predicate}`}
            title="删除这条记忆"
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
}
