/**
 * 功能概述：现有情境/检查/Memory 页内的领域目录与精确详情，连接观察、进度、原生循环、行动和来源。
 * DomainInspection 从 URL 恢复 scope/consumer/选择/游标；请求使用正式 wire schema，400/409 由用户显式刷新首屏。
 * SafeContent 显示服务端省略及截断；RunDetail 仅呈现配对已验证的结果，Memory 正文仅使用带知识边界的 history。
 * InspectionReference 负责跨领域引用；环境 mutation 留给 EnvironmentControl。本文件只有 GET 与受保护导航。
 * boundary 是目录候选上界，stateReadAt 是当前状态读取时间；空页与窗口耗尽均不推断没有更多历史。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  inspectionObservationPageSchema,
  inspectionObservationDetailSchema,
  inspectionProgressPageSchema,
  inspectionRunPageSchema,
  inspectionRunDetailSchema,
  inspectionActionPageSchema,
  inspectionActionDetailSchema,
  inspectionMemoryHistorySchema,
  inspectionGuiTaskPageSchema,
  inspectionGuiTaskDetailSchema,
  inspectionSourceSchema,
  inspectionEnvironmentSchema,
  type inspectionSafeContentSchema,
  type JsonValue,
  type z,
} from "@kaguya/schema";
import { Button, FieldMessage } from "./components/ui.js";
import {
  useWorkbenchNavigate,
  restoreWorkbenchPosition,
} from "./components/AppShell.js";
import { ReadableValue } from "./InspectionFields.js";
import { useInspection } from "./use-inspection.js";
import {
  InspectionReference,
  type DomainReference,
} from "./InspectionReference.js";
import {
  inspectionApiPath,
  inspectionPage,
  inspectionDomains,
  inspectionLocation,
  readInspectionLocation,
  type InspectionLocation,
} from "./inspection-navigation.js";
import { EnvironmentControl } from "./EnvironmentControl.js";
import "./domain-inspection.css";

const pages = {
  observation: inspectionObservationPageSchema,
  progress: inspectionProgressPageSchema,
  run: inspectionRunPageSchema,
  action: inspectionActionPageSchema,
  "gui-task": inspectionGuiTaskPageSchema,
  memory: inspectionMemoryHistorySchema,
};
const details = {
  observation: inspectionObservationDetailSchema,
  run: inspectionRunDetailSchema,
  action: inspectionActionDetailSchema,
  "gui-task": inspectionGuiTaskDetailSchema,
  atom: inspectionSourceSchema,
  environment: inspectionEnvironmentSchema,
};
type Page = ReturnType<(typeof pages)[keyof typeof pages]["parse"]>;
type Detail = ReturnType<(typeof details)[keyof typeof details]["parse"]>;
type Safe = z.infer<typeof inspectionSafeContentSchema>;
const labels: Record<string, string> = {
  observationId: "观察 ID",
  sceneId: "场景",
  consumerId: "消费方",
  policyVersion: "策略版本",
  streamId: "进度流",
  revision: "修订",
  successfulThrough: "连续成功水位",
  discoveredThrough: "已发现水位",
  allocatedThrough: "已分配水位",
  latestObservationId: "最近观察",
  openCount: "未完成观察数",
  afterPosition: "起始位置（不含）",
  throughPosition: "截止位置",
  receivedThroughPosition: "接收截止位置",
  hasMore: "冻结时仍有后续输入",
  complete: "输入清单完整",
  resultInformationId: "结果 Information",
  errorCode: "错误",
  deferredUntil: "延后至",
  replacementObservationId: "替代观察",
  runInformationId: "模型运行 ID",
  actionRunInformationId: "行动运行 ID",
  at: "记录时间",
  deadline: "截止时间",
  terminalReason: "运行终止原因",
  status: "状态",
  state: "状态",
  intentId: "行动 ID",
  toolName: "工具",
  attemptId: "执行尝试 ID",
  receiptId: "回执 ID",
  cancellationId: "停止请求 ID",
  decisionInformationId: "决策 ID",
  taskRequestId: "用户任务 ID",
  requestedInformationId: "任务来源 ID",
  environmentId: "桌面环境",
  generation: "控制代际",
  nodeId: "记忆 ID",
  publicationInformationId: "发布 Information",
  publicationPosition: "发布位置",
  availability: "当前可用性",
  reasons: "当前不可用原因",
  ordinal: "尝试序号",
  event: "事件",
  recordedAt: "记录时间",
  phase: "模型阶段",
  reasonCode: "阶段原因",
  frozenInformationId: "冻结输入 ID",
  requestInformationId: "请求 ID",
  dispatchInformationId: "派发 ID",
  terminalInformationId: "模型终态 ID",
  generationKind: "生成类型",
  stepIndex: "步骤",
  callIndex: "调用序号",
  toolCallId: "调用 ID",
  toolId: "工具 ID",
  toolVersion: "工具版本",
  wireName: "工具调用名",
  validation: "参数校验",
  pairing: "结果配对",
  outputBytes: "结果字节数",
  contextTrimming: "输入裁剪",
  measurement: "测量对象",
  omittedSegments: "省略段数",
  truncated: "已截断",
  originalBytes: "原字节数",
  retainedBytes: "保留字节数",
  budgetBytes: "预算字节数",
  admittedSteps: "已准入步骤数",
  registeredCalls: "已登记调用数",
  projectedOutputBytes: "已投影结果字节数",
  informationId: "Information ID",
  reconcilesReceiptId: "核对原回执",
  evidence: "证据",
  providerReceiptId: "提供方回执",
  environmentValidation: "环境校验",
  resultHash: "结果摘要",
  responseDigest: "迟到响应摘要",
  kind: "类型",
  occurredAt: "发生时间",
  reason: "原因",
};
const words: Record<string, string> = {
  frozen: "已冻结",
  completed: "已完成",
  failed: "失败",
  queued: "排队中",
  running: "运行中",
  stopped: "已停止",
  unknown: "结果未知",
  partial: "部分完成",
  succeeded: "执行成功",
  pending: "待确认",
  forwarded: "停止请求已转发",
  verified: "配对已验证",
  invalid: "配对校验未通过",
  available: "当前可用",
  unavailable: "当前不可用",
  unrecorded: "未记录",
  "source-proof-missing": "来源证明未记录",
  "source-withdrawal": "来源已撤回",
  "identity-split": "身份已拆分",
  inactive: "当前已失效",
  "dependency-invalid": "依赖已失效",
  "domain-detail-required": "正文须从对应领域详情查看",
  "gui-task": "GUI 任务原始终态",
  "native-run": "模型运行投影",
  execution: "执行耗尽",
  ready: "自动控制就绪",
  human: "人工控制",
  draining: "输入排空中",
  quarantined: "环境已隔离",
  isolation_failed: "环境隔离未确认",
  preparing: "准备中",
  "model-outcome-unknown": "模型结果未知",
  "dispatched-without-terminal": "已派发，未记录终态",
};
export function domainLabel(value: string): string {
  return words[value] ?? value;
}
export function DomainFields({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="domain-fields">
      {Object.entries(value).map(([key, raw]) => (
        <div key={key}>
          <dt>{labels[key] ?? key}</dt>
          <dd>
            {raw === null || raw === undefined ? (
              "未记录"
            ) : typeof raw === "string" ? (
              [
                "state",
                "status",
                "availability",
                "evidence",
                "reason",
                "reasonCode",
                "terminalReason",
                "pairing",
                "validation",
                "environmentValidation",
              ].includes(key) ? (
                domainLabel(raw)
              ) : (
                raw
              )
            ) : (
              <ReadableValue value={raw as JsonValue} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function SafeContent({
  content,
  title,
}: {
  content: Safe | null;
  title: string;
}) {
  return (
    <section className="domain-content">
      <h4>{title}</h4>
      {content ? (
        <>
          <ReadableValue value={content.value} />
          {!!content.omitted.length && (
            <p>已省略：{content.omitted.join("、")}</p>
          )}
          {content.truncated && <p role="status">此正文已截断。</p>}
        </>
      ) : (
        <p>未记录或当前不可读取。</p>
      )}
    </section>
  );
}
function Notice({
  truncated,
  children,
}: {
  truncated: boolean;
  children: ReactNode;
}) {
  return truncated ? <p role="status">{children}</p> : null;
}
function memoryHandles(value: JsonValue): { id: string; revision: string }[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(memoryHandles);
  if (typeof value.nodeId === "string")
    return [{ id: value.nodeId, revision: String(value.revision ?? "未记录") }];
  return Object.values(value).flatMap(memoryHandles);
}
function MemoryLinks({
  content,
  location,
  context,
}: {
  content: Safe | null;
  location: string;
  context: InspectionLocation;
}) {
  const nodes = content ? memoryHandles(content.value) : [];
  return nodes.length ? (
    <section aria-label="冻结记忆修订">
      <h4>冻结记忆修订</h4>
      {nodes.map((node, i) => (
        <p key={`${node.id}:${i}`}>
          修订 {node.revision} ·{" "}
          <InspectionReference
            reference={{
              domain: "memory",
              id: node.id,
              relation: "当时可知的记忆",
              availability: context.observation ? "available" : "unrecorded",
            }}
            location={location}
            context={context}
          />
        </p>
      ))}
    </section>
  ) : null;
}
function References({
  items,
  location,
  context,
}: {
  items: DomainReference[];
  location: string;
  context: InspectionLocation;
}) {
  return (
    <section className="domain-references" aria-label="关联与来源">
      <h4>关联与来源</h4>
      {items.length ? (
        items.map((reference, index) => (
          <InspectionReference
            key={`${reference.id}:${index}`}
            reference={reference}
            location={location}
            context={context}
          />
        ))
      ) : (
        <p>未记录关联。</p>
      )}
    </section>
  );
}
function itemIdentity(item: Page["items"][number]) {
  if ("streamId" in item)
    return {
      id: item.streamId,
      title: item.consumerId,
      status: `未完成观察 ${item.openCount}`,
    };
  if ("publicationInformationId" in item)
    return {
      id: `${item.nodeId}:${item.revision}`,
      title: `修订 ${item.revision}`,
      status: domainLabel(item.availability),
    };
  if ("taskRequestId" in item)
    return {
      id: item.requestedInformationId,
      title: item.taskRequestId,
      status: `代际 ${item.generation}`,
    };
  if ("intentId" in item)
    return {
      id: item.intentId,
      title: item.toolName,
      status: domainLabel(item.state),
    };
  if ("runInformationId" in item)
    return {
      id: item.runInformationId,
      title: item.runInformationId,
      status: item.terminalReason
        ? domainLabel(item.terminalReason)
        : "未记录终态",
    };
  return {
    id: item.observationId,
    title: item.observationId,
    status: domainLabel(item.status),
  };
}
export function DomainInspection({
  token,
  location,
  defaultScope = "",
}: {
  token: string;
  location: string;
  defaultScope?: string;
}) {
  const navigate = useWorkbenchNavigate();
  const route = readInspectionLocation(location, defaultScope);
  const [refresh, setRefresh] = useState(0);
  const pageSchema = useMemo(
    () => ({
      parse: (value: unknown): Page =>
        pages[route.domain as keyof typeof pages]?.parse(value) ??
        inspectionObservationPageSchema.parse(value),
    }),
    [route.domain],
  );
  const detailSchema = useMemo(
    () => ({
      parse: (value: unknown): Detail =>
        details[route.domain as keyof typeof details]?.parse(value) ??
        inspectionObservationDetailSchema.parse(value),
    }),
    [route.domain],
  );
  const paged = Object.hasOwn(pages, route.domain);
  const page = useInspection(
    token,
    paged ? inspectionApiPath(route) : undefined,
    pageSchema,
    refresh,
  );
  const detail = useInspection(
    token,
    route.selected && route.domain !== "memory" && route.domain !== "progress"
      ? inspectionApiPath(route, true)
      : undefined,
    detailSchema,
    refresh,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedByClick = useRef(false);
  useEffect(() => {
    if (detail.data && selectedByClick.current) {
      selectedByClick.current = false;
      heading.current?.focus();
    }
    if (page.data || detail.data) restoreWorkbenchPosition();
  }, [page.data, detail.data]);
  const change = (next: Partial<InspectionLocation>) => {
    void navigate(inspectionLocation(location, { ...route, ...next }));
  };
  const reload = () => {
    if (route.cursors.length) change({ cursors: [] });
    setRefresh((n) => n + 1);
  };
  const error = detail.error ? detail : page;
  const resetNeeded =
    error.code === "invalid_cursor" ||
    error.code === "inspection_directory_changed";
  let context = route;
  if (detail.data && "observation" in detail.data)
    context = {
      ...route,
      observation: detail.data.observation.observationId,
      step: "",
    };
  if (
    detail.data &&
    "run" in detail.data &&
    detail.data.run &&
    "observationId" in detail.data.run
  )
    context = { ...route, observation: detail.data.run.observationId };
  if (detail.data && "action" in detail.data)
    context = { ...route, observation: detail.data.action.observationId };
  if (detail.data && "task" in detail.data)
    context = { ...route, observation: detail.data.task.observationId };
  const detailPanel = route.selected &&
    route.domain !== "memory" &&
    route.domain !== "progress" && (
      <article className="domain-detail" aria-label="领域详情">
        <h3 ref={heading} tabIndex={-1}>
          {inspectionDomains[route.domain]}详情
        </h3>
        <Button onClick={() => change({ selected: "" })}>返回列表</Button>
        {!detail.data && !detail.error ? (
          <FieldMessage>正在读取详情…</FieldMessage>
        ) : (
          detail.data && (
            <DetailContent
              data={detail.data}
              location={location}
              context={context}
            />
          )
        )}
      </article>
    );
  return (
    <section className="domain-inspection" aria-label="运行与来源检视">
      <header className="domain-heading">
        <h2>运行与来源</h2>
        <Button onClick={reload}>刷新记录</Button>
      </header>
      <form
        className="domain-filters"
        key={`${route.scope}:${route.consumer}:${route.domain}`}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          change({
            scope: String(form.get("scope") ?? "").trim(),
            consumer: String(form.get("consumer") ?? "").trim(),
            selected: "",
            observation: "",
            step: "",
            cursors: [],
          });
        }}
      >
        <label>
          数据范围
          <input
            name="scope"
            defaultValue={route.scope}
            required
            placeholder="沿用观察的规范 scope"
          />
        </label>
        {(route.domain === "observation" || route.domain === "progress") && (
          <label>
            消费方
            <input
              name="consumer"
              defaultValue={route.consumer}
              placeholder="全部消费方"
            />
          </label>
        )}
        <Button type="submit">应用范围</Button>
      </form>
      <nav className="domain-tabs" aria-label="领域记录">
        {(
          [
            "observation",
            "progress",
            "run",
            "action",
            "gui-task",
            "environment",
          ] as const
        ).map((domain) => (
          <Button
            key={domain}
            aria-pressed={route.domain === domain}
            onClick={() =>
              change({
                domain,
                selected: "",
                consumer: "",
                observation: "",
                step: "",
                cursors: [],
              })
            }
          >
            {inspectionDomains[domain]}
          </Button>
        ))}
      </nav>
      {route.domain !== "progress" && route.domain !== "environment" && (
        <form
          className="domain-filters"
          key={`${route.domain}:${route.selected}:${route.observation}:${route.step}`}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            change({
              selected: String(form.get("selected") ?? "").trim(),
              observation: String(
                form.get("observation") ?? route.observation,
              ).trim(),
              step: String(form.get("step") ?? route.step).trim(),
              cursors: [],
            });
          }}
        >
          <label>
            已知对象 ID
            <input name="selected" defaultValue={route.selected} required />
          </label>
          {route.domain === "memory" && (
            <>
              <label>
                原观察 ID
                <input
                  name="observation"
                  defaultValue={route.observation}
                  required
                />
              </label>
              <label>
                原模型步骤 ID（可选）
                <input name="step" defaultValue={route.step} />
              </label>
            </>
          )}
          <Button type="submit">查看指定记录</Button>
        </form>
      )}
      {!route.scope ? (
        <FieldMessage>选择情境或输入数据范围后查看记录。</FieldMessage>
      ) : (
        <>
          {error.error && (
            <FieldMessage tone="error">
              {resetNeeded
                ? "目录已变化或游标已失效。请刷新首屏，当前范围与过滤保持不变。"
                : `${error.error}${error.code ? ` · ${error.code}` : ""}`}
              <Button onClick={reload}>
                {resetNeeded ? "刷新首屏" : "重新读取"}
              </Button>
            </FieldMessage>
          )}
          {route.domain === "environment" && (
            <EnvironmentControl
              key={`${token}:${route.scope}`}
              token={token}
              scope={route.scope}
              location={location}
            />
          )}
          {route.domain === "memory" &&
            (!route.selected || !route.observation) && (
              <FieldMessage>
                请从原观察或模型步骤中的记忆修订进入；未记录知识边界时不能读取正文。
              </FieldMessage>
            )}
          {(route.domain === "atom" || route.domain === "memory") && (
            <p>
              {inspectionDomains[route.domain]} ·{" "}
              <code>{route.selected || "未选择"}</code>
            </p>
          )}
          {paged && page.data && (
            <>
              <div className="domain-boundary">
                <span>
                  目录候选上界 {page.data.boundary.position} ·{" "}
                  {page.data.boundary.recordedAt}
                </span>
                <span>当前状态读取于 {page.data.stateReadAt}</span>
              </div>
              <Notice truncated={page.data.directory?.truncated ?? false}>
                目录仅覆盖最近 {page.data.directory?.limit ?? 500}{" "}
                个候选，窗口外仍有历史；已知 ID 可直接查看。
              </Notice>
              <Notice truncated={page.data.truncated}>
                当前分页或内容已截断，按可用游标继续读取。
              </Notice>
              {"knowledgeCutoff" in page.data && (
                <p>
                  当时知识截止位置 {page.data.knowledgeCutoff} · 排除{" "}
                  {page.data.excludedCount} 项
                  {page.data.exclusionReason ? "（来源缺失或不可访问）" : ""}
                </p>
              )}
              {!page.data.items.length && (
                <p>
                  本页无可显示记录。{page.data.nextCursor ? "仍有下一页。" : ""}
                </p>
              )}
              <div className="domain-browser">
                <ol
                  className="domain-directory"
                  aria-label={`${inspectionDomains[route.domain]}目录`}
                  data-scroll-key="domain-directory"
                >
                  {page.data.items.map((item) => {
                    const identity = itemIdentity(item);
                    return (
                      <li key={identity.id}>
                        {"holes" in item ? (
                          <article>
                            <h3>{item.consumerId}</h3>
                            <DomainFields
                              value={{
                                sceneId: item.sceneId,
                                policyVersion: item.policyVersion,
                                successfulThrough: item.successfulThrough,
                                allocatedThrough: item.allocatedThrough,
                                discoveredThrough: item.discoveredThrough,
                                openCount: item.openCount,
                              }}
                            />
                            <p>
                              积压位置区间：{item.backlog.afterPosition} →{" "}
                              {item.backlog.throughPosition}
                            </p>
                            {item.holes.map((hole) => (
                              <section key={hole.observationId}>
                                <InspectionReference
                                  reference={{
                                    domain: "observation",
                                    id: hole.observationId,
                                    relation: "未完成观察",
                                    availability: "available",
                                  }}
                                  location={location}
                                  context={context}
                                />
                                <DomainFields value={hole} />
                              </section>
                            ))}
                            <Notice truncated={item.holesTruncated}>
                              缺口仅显示前 100 项。
                            </Notice>
                          </article>
                        ) : "historical" in item ? (
                          <article>
                            <h3>{identity.title}</h3>
                            <DomainFields
                              value={{
                                nodeId: item.nodeId,
                                revision: item.revision,
                                publicationInformationId:
                                  item.publicationInformationId,
                                publicationPosition: item.publicationPosition,
                                status: item.status,
                                availability: item.availability,
                                reasons: item.reasons.map(domainLabel),
                              }}
                            />
                            {item.availability === "available" ? (
                              <SafeContent
                                content={item.historical}
                                title="冻结修订正文"
                              />
                            ) : (
                              <p>当前正文不可读取，历史发布身份保留。</p>
                            )}
                            <References
                              items={item.references}
                              location={location}
                              context={context}
                            />
                            <Notice truncated={item.referencesTruncated}>
                              此修订的引用已截断。
                            </Notice>
                          </article>
                        ) : (
                          <Button
                            id={`domain-row-${encodeURIComponent(identity.id)}`}
                            aria-pressed={route.selected === identity.id}
                            onClick={() => {
                              selectedByClick.current = true;
                              change({ selected: identity.id });
                            }}
                          >
                            <strong>{identity.title}</strong>
                            <span>{identity.status}</span>
                            <code>{identity.id}</code>
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {detailPanel}
              </div>
              <nav className="domain-pager" aria-label="领域分页">
                <Button
                  disabled={!route.cursors.length}
                  onClick={() =>
                    change(inspectionPage(route, route.cursors.slice(0, -1)))
                  }
                >
                  上一页
                </Button>
                <span>第 {route.cursors.length + 1} 页</span>
                <Button
                  disabled={!page.data.nextCursor}
                  onClick={() =>
                    change(
                      inspectionPage(route, [
                        ...route.cursors,
                        page.data!.nextCursor!,
                      ]),
                    )
                  }
                >
                  下一页
                </Button>
              </nav>
            </>
          )}
          {paged && !page.data && detailPanel}
          {!paged &&
            route.domain === "atom" &&
            (detail.data ? (
              <DetailContent
                data={detail.data}
                location={location}
                context={context}
              />
            ) : (
              !detail.error && <p>正在读取来源…</p>
            ))}
          {paged && !page.data && !page.error && inspectionApiPath(route) && (
            <FieldMessage>正在读取领域记录…</FieldMessage>
          )}
        </>
      )}
    </section>
  );
}
function DetailContent({
  data,
  location,
  context,
}: {
  data: Detail;
  location: string;
  context: InspectionLocation;
}) {
  const references = "references" in data ? data.references : [];
  return (
    <>
      <p className="domain-read-time">当前状态读取于 {data.stateReadAt}</p>
      {"observation" in data && (
        <>
          <DomainFields value={data.observation} />
          <SafeContent content={data.manifest} title="原冻结清单" />
          <MemoryLinks
            content={data.manifest}
            location={location}
            context={context}
          />
          {data.attempts.map((attempt) => (
            <section key={attempt.ordinal}>
              <DomainFields
                value={{
                  ordinal: attempt.ordinal,
                  event: attempt.event,
                  recordedAt: attempt.recordedAt,
                }}
              />
              <SafeContent content={attempt.detail} title="观察尝试" />
            </section>
          ))}
          <Notice truncated={data.attemptsTruncated}>观察尝试已截断。</Notice>
        </>
      )}
      {"usage" in data && (
        <>
          <DomainFields value={data.run} />
          <SafeContent content={data.budget} title="运行预算" />
          <DomainFields value={data.usage} />
          {data.cancellation && (
            <p>
              停止请求：{domainLabel(data.cancellation.state)}
              ；执行终态单独记录。
            </p>
          )}
          {data.cancellation && (
            <References
              items={[
                {
                  domain: "atom",
                  id: data.cancellation.requestedInformationId,
                  relation: "原停止请求",
                  availability: "available",
                },
                ...(data.cancellation.forwardedInformationId
                  ? [
                      {
                        domain: "atom" as const,
                        id: data.cancellation.forwardedInformationId,
                        relation: "停止转发事实",
                        availability: "available" as const,
                      },
                    ]
                  : []),
              ]}
              location={location}
              context={context}
            />
          )}
          {data.steps.map((step) => (
            <section key={step.stepIndex}>
              <h4>模型步骤 {step.stepIndex}</h4>
              <DomainFields
                value={{
                  stepIndex: step.stepIndex,
                  phase: step.phase,
                  reasonCode: step.reasonCode,
                  frozenInformationId: step.frozenInformationId,
                  requestInformationId: step.requestInformationId,
                  dispatchInformationId: step.dispatchInformationId,
                  terminalInformationId: step.terminalInformationId,
                }}
              />
              {step.contextTrimming ? (
                <DomainFields value={step.contextTrimming} />
              ) : (
                <p>输入裁剪未记录。</p>
              )}
              <SafeContent content={step.frozen} title="该步冻结输入" />
              <MemoryLinks
                content={step.frozen}
                location={location}
                context={{ ...context, step: step.frozenInformationId }}
              />
            </section>
          ))}
          <Notice truncated={data.stepsTruncated}>模型步骤已截断。</Notice>
          {data.calls.map((call) => (
            <section key={`${call.stepIndex}:${call.callIndex}`}>
              <h4>
                工具调用 {call.stepIndex} / {call.callIndex}
              </h4>
              <DomainFields
                value={{
                  toolCallId: call.toolCallId,
                  toolId: call.toolId,
                  validation: call.validation,
                  pairing: call.pairing,
                  resultInformationId: call.resultInformationId,
                }}
              />
              <SafeContent content={call.arguments} title="调用参数" />
              {call.pairing === "verified" ? (
                <SafeContent content={call.result} title="已验证配对结果" />
              ) : (
                <p>
                  {call.pairing === "invalid"
                    ? "配对校验未通过，结果正文不予展示。"
                    : "结果配对待确认。"}
                </p>
              )}
              {[call.intent, call.receipt]
                .filter((ref): ref is DomainReference => Boolean(ref))
                .map((ref) => (
                  <InspectionReference
                    key={ref.id}
                    reference={ref}
                    location={location}
                    context={context}
                  />
                ))}
            </section>
          ))}
          <Notice truncated={data.callsTruncated}>工具调用已截断。</Notice>
        </>
      )}
      {"action" in data && (
        <>
          <DomainFields value={data.action} />
          <SafeContent content={data.intent} title="原行动意图" />
          {data.receipts.map((receipt) => (
            <section key={receipt.informationId}>
              <h4>{receipt.reconcilesReceiptId ? "核对回执" : "执行回执"}</h4>
              <DomainFields
                value={{
                  informationId: receipt.informationId,
                  attemptId: receipt.attemptId,
                  reconcilesReceiptId: receipt.reconcilesReceiptId,
                  status: receipt.status,
                  evidence: receipt.evidence,
                  environmentValidation: receipt.environmentValidation,
                  resultHash: receipt.resultHash,
                }}
              />
              <SafeContent content={receipt.content} title="回执内容" />
              <Notice truncated={receipt.truncated}>执行结果已截断。</Notice>
            </section>
          ))}
          <Notice truncated={data.receiptsTruncated}>回执列表已截断。</Notice>
          <h4>迟到证据</h4>
          <p>
            迟到数据不改变原未知或部分完成的结果。未通过证明的候选{" "}
            {data.rejectedEvidenceCount} 项。
          </p>
          {data.lateEvidence.map((late) => (
            <section key={late.informationId}>
              <DomainFields
                value={{
                  informationId: late.informationId,
                  at: late.at,
                  responseDigest: late.responseDigest,
                }}
              />
              <SafeContent content={late.value} title="迟到证据内容" />
              <SafeContent content={late.source} title="迟到证据来源与连接" />
              <SafeContent content={late.requests} title="关联请求与操作身份" />
            </section>
          ))}
          <Notice truncated={data.lateEvidenceTruncated}>
            迟到证据已截断。
          </Notice>
        </>
      )}
      {"task" in data && (
        <>
          <DomainFields
            value={{
              taskRequestId: data.task.taskRequestId,
              requestedInformationId: data.task.requestedInformationId,
              environmentId: data.task.environmentId,
              generation: data.task.generation,
              status: data.status,
            }}
          />
          <p>终态来源：{domainLabel(data.terminalSource)}</p>
          {data.cancellation && (
            <p>
              停止请求：{domainLabel(data.cancellation.state)}；不表示效果撤回。
            </p>
          )}
          {data.cancellation && (
            <References
              items={[
                {
                  domain: "atom",
                  id: data.cancellation.requestedInformationId,
                  relation: "原停止请求",
                  availability: "available",
                },
                ...(data.cancellation.forwardedInformationId
                  ? [
                      {
                        domain: "atom" as const,
                        id: data.cancellation.forwardedInformationId,
                        relation: "停止转发事实",
                        availability: "available" as const,
                      },
                    ]
                  : []),
              ]}
              location={location}
              context={context}
            />
          )}
          <SafeContent content={data.terminal} title="任务终态" />
          {data.run && (
            <InspectionReference
              reference={data.run}
              location={location}
              context={context}
            />
          )}
        </>
      )}
      {"informationId" in data && (
        <>
          <DomainFields
            value={{
              informationId: data.informationId,
              kind: data.kind,
              occurredAt: data.occurredAt,
              availability: data.availability,
              reason: data.reason,
            }}
          />
          {data.availability === "available" ? (
            <SafeContent content={data.content} title="原始来源" />
          ) : (
            <p>来源当前不可读取。</p>
          )}
        </>
      )}
      <References items={references} location={location} context={context} />
      <Notice
        truncated={"referencesTruncated" in data && data.referencesTruncated}
      >
        关联与来源已截断。
      </Notice>
    </>
  );
}
