/**
 * 功能概述：Manifest 驱动的逐模型请求检查页，一行对应一次持久化请求，详情以独立页面展示。
 * 主要职责：RequestSurface 保持当前模块的分页栈并按路由加载列表或单次请求；RequestDetail
 * 互斥呈现概览、完整 Prompt 或来源与投递；来源子路由以单条 Atom 替代关联列表，不叠加详情。
 * CopyPrompt 复制服务端脱敏后的完整原文并反馈失败。
 * 代码库关系：ModulePages/ModuleSurface 根据 model-request-browser 声明挂载，DTO 由 schema 校验；
 * useInspection 复用认证、取消和过期结果隔离，导航通过 AppShell 守卫并保留原生链接语义。
 * 输入输出与副作用：只读 GET 和用户触发的剪贴板写入，不执行 Prompt、不重放、不推断请求成功或投递成功。
 * 列表与详情切换不卸载本组件，返回时保留分页；直接进入或刷新详情后返回列表从首页开始。
 */
import {
  inspectionRequestPageSchema,
  inspectionRequestDetailSchema,
  type InspectionModule,
  type InspectionRequestDetail,
  type InspectionRequestSummary,
} from "@kaguya/schema";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import { useWorkbenchNavigate } from "./components/AppShell.js";
import { Button, FieldMessage } from "./components/ui.js";
import { InspectionFields, statusLabel } from "./InspectionFields.js";
import {
  InspectionPager,
  type InspectionDetailProps,
} from "./ModuleRuntimeSection.js";
import { navigateModuleLink, moduleDetailPath } from "./ModulePages.js";
import {
  requestDetailPath,
  requestRoute,
  type RequestView,
} from "./request-routes.js";
import { useInspection } from "./use-inspection.js";
import "./request-surface.css";

type SurfaceComponent = NonNullable<
  NonNullable<InspectionModule["inspection"]>["surface"]
>["components"][number];
export type RequestBrowser = Extract<
  SurfaceComponent,
  { type: "model-request-browser" }
>;
function RequestLink({
  path,
  children,
  className,
  current,
}: {
  path: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
}) {
  const navigate = useWorkbenchNavigate();
  return (
    <a
      href={path}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={(event) => navigateModuleLink(event, path, navigate)}
    >
      {children}
    </a>
  );
}
function requestStatus(status: string) {
  return (
    (
      { pending: "未记录结果", interrupted: "已中断" } as Record<string, string>
    )[status] ?? statusLabel(status)
  );
}
function displayDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function CopyPrompt({ text }: { text: string }) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="request-copy">
      <Button
        onClick={async () => {
          setFeedback("");
          try {
            await navigator.clipboard.writeText(text);
            setFeedback("已复制完整 Prompt");
          } catch {
            setFeedback("复制失败，请选择下方原文后手动复制。");
          }
        }}
      >
        <Copy size={15} aria-hidden="true" />
        复制完整 Prompt
      </Button>
      <span role="status">{feedback}</span>
    </div>
  );
}
export function RequestSurface({
  module,
  browser,
  token,
  revision,
  path,
  DetailComponent,
}: {
  module: InspectionModule;
  browser: RequestBrowser;
  token: string;
  revision: number;
  path: string;
  DetailComponent?: ComponentType<InspectionDetailProps> | undefined;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const loadedPage = useRef<InspectionRequestSummary[]>([]);
  const route = requestRoute(path);
  const surface = module.inspection!.surface!;
  const composer = browser.mode === "composer";
  const title = surface.title;
  const base = `modules/${encodeURIComponent(module.definitionId)}/surfaces/${encodeURIComponent(surface.id)}`;
  const parameters = new URLSearchParams({ limit: "20" });
  if (cursors.length) parameters.set("cursor", cursors.at(-1)!);
  const page = useInspection(
    token,
    route ? undefined : `${base}?${parameters}`,
    inspectionRequestPageSchema,
    revision + refresh,
  );
  const detail = useInspection(
    token,
    route
      ? `${base}/requests/${encodeURIComponent(route.requestId)}`
      : undefined,
    inspectionRequestDetailSchema,
    revision + refresh,
  );
  const retry = () => setRefresh((value) => value + 1);
  useEffect(() => {
    if (page.data) loadedPage.current = page.data.items;
  }, [page.data]);
  if (route)
    return (
      <RequestDetail
        key={route.requestId}
        module={module}
        composer={composer}
        requestId={route.requestId}
        view={route.view}
        sourceInformationId={route.sourceInformationId}
        state={detail}
        retry={retry}
        token={token}
        revision={revision + refresh}
        DetailComponent={DetailComponent}
        siblings={loadedPage.current}
      />
    );
  return (
    <section className="request-history" aria-label={`${title}请求记录`}>
      <div className="request-list-heading">
        <h3>{title}</h3>
        <p>
          {page.data
            ? `本页 ${page.data.items.length} 次请求 · 非全部统计 · `
            : ""}
          按请求时间倒序
        </p>
      </div>
      {page.error ? (
        <RequestError
          message={`请求记录读取失败：${page.error}`}
          retry={retry}
        />
      ) : !page.data ? (
        <FieldMessage>正在加载请求记录…</FieldMessage>
      ) : !page.data.items.length ? (
        <div className="request-state">
          <h3>暂无请求记录</h3>
          <p>
            {composer
              ? "Planner 决定表达并发起生成请求后，记录会出现在这里。"
              : "发起 Planner 请求后，记录会出现在这里。"}
          </p>
        </div>
      ) : (
        <div
          className={`request-list${composer ? " request-list-composer" : ""}`}
        >
          <div className="request-columns" aria-hidden="true">
            <span>时间</span>
            <span>触发消息</span>
            <span>{composer ? "生成内容" : "决定动作"}</span>
            <span />
          </div>
          {page.data.items.map((item) => (
            <RequestLink
              key={item.requestId}
              className="request-summary"
              path={requestDetailPath(module.definitionId, item.requestId)}
            >
              <time className="request-time" dateTime={item.occurredAt}>
                {displayDate(item.occurredAt)}
              </time>
              <span className="request-trigger">
                <span className="request-message">
                  {item.triggerText || "触发上下文不可用"}
                </span>
                {item.inputCount > 1 && (
                  <span className="request-input-count">
                    {item.inputCount} 条
                  </span>
                )}
              </span>
              <span
                className={`request-outcome${item.status === "failed" ? " request-outcome-failed" : ""}`}
              >
                {item.outcomeText || requestStatus(item.status)}
              </span>
              <ChevronRight
                className="request-chevron"
                size={17}
                aria-hidden="true"
              />
            </RequestLink>
          ))}
          <p className="request-list-help">
            选择一条记录，查看请求详情与完整 Prompt。
          </p>
        </div>
      )}
      {page.data && (
        <InspectionPager
          cursors={cursors}
          next={page.data.nextCursor}
          change={setCursors}
        />
      )}
    </section>
  );
}
function RequestError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="request-state">
      <FieldMessage tone="error">
        {message}。可刷新重试，或返回列表选择其他记录。
      </FieldMessage>
      <Button onClick={retry}>重新读取</Button>
    </div>
  );
}
function RequestDetail({
  module,
  composer,
  requestId,
  view,
  state,
  retry,
  sourceInformationId,
  token,
  revision,
  DetailComponent,
  siblings,
}: {
  module: InspectionModule;
  composer: boolean;
  requestId: string;
  view: RequestView;
  state: { data?: InspectionRequestDetail; error?: string };
  retry: () => void;
  sourceInformationId?: string | undefined;
  token: string;
  revision: number;
  DetailComponent?: ComponentType<InspectionDetailProps> | undefined;
  siblings: InspectionRequestSummary[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useWorkbenchNavigate();
  useEffect(() => {
    heading.current?.focus();
  }, [requestId, view, sourceInformationId]);
  const data = state.data;
  const siblingIndex = siblings.findIndex(
    (item) => item.requestId === requestId,
  );
  return (
    <article className="request-history request-detail">
      <div className="request-detail-navigation">
        <RequestLink
          path={moduleDetailPath(module.definitionId)}
          className="request-back"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          返回{composer ? "消息生成" : "Planner 决策"}列表
        </RequestLink>
        {siblingIndex >= 0 && (
          <nav className="request-siblings" aria-label="本页相邻请求">
            {siblingIndex > 0 && (
              <RequestLink
                path={requestDetailPath(
                  module.definitionId,
                  siblings[siblingIndex - 1]!.requestId,
                  view,
                )}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                上一条
              </RequestLink>
            )}
            <span>
              本页 {siblingIndex + 1} / {siblings.length}
            </span>
            {siblingIndex < siblings.length - 1 && (
              <RequestLink
                path={requestDetailPath(
                  module.definitionId,
                  siblings[siblingIndex + 1]!.requestId,
                  view,
                )}
              >
                下一条
                <ChevronRight size={16} aria-hidden="true" />
              </RequestLink>
            )}
          </nav>
        )}
        <Button onClick={retry}>刷新</Button>
      </div>
      <header className="request-detail-heading">
        <h1 ref={heading} tabIndex={-1}>
          {composer ? "消息生成详情" : "Planner 决策详情"}
        </h1>
        {data && (
          <p>
            <time dateTime={data.request.occurredAt}>
              {displayDate(data.request.occurredAt)}
            </time>
            <span>{requestStatus(data.request.status)}</span>
          </p>
        )}
      </header>
      {state.error ? (
        <RequestError
          message={`这次请求不可用：${state.error}`}
          retry={retry}
        />
      ) : !data ? (
        <FieldMessage>正在加载请求详情…</FieldMessage>
      ) : (
        <>
          <nav className="request-detail-tabs" aria-label="请求详情内容">
            {(
              [
                ["overview", "概览"],
                ["prompt", "完整 Prompt"],
                ["sources", "来源与投递"],
              ] as const
            ).map(([key, label]) => (
              <RequestLink
                key={key}
                path={requestDetailPath(module.definitionId, requestId, key)}
                current={key === view}
              >
                {label}
              </RequestLink>
            ))}
          </nav>
          {view === "overview" ? (
            <RequestOverview data={data} composer={composer} />
          ) : view === "prompt" ? (
            <section
              className="request-prompt"
              aria-label="本次 LLM 请求的完整 Prompt"
            >
              {data.prompt.available && data.prompt.text !== undefined ? (
                <>
                  <div className="request-prompt-heading">
                    <p>本次请求的完整原文 · 已执行秘密脱敏</p>
                    <CopyPrompt text={data.prompt.text} />
                  </div>
                  <pre tabIndex={0}>{data.prompt.text}</pre>
                </>
              ) : (
                <FieldMessage>
                  这次请求未保存可读取的 Prompt，无法还原完整原文。
                </FieldMessage>
              )}
            </section>
          ) : sourceInformationId ? (
            <section
              className="request-source-record"
              aria-label="关联记录详情"
            >
              <RequestLink
                className="request-back"
                path={requestDetailPath(
                  module.definitionId,
                  requestId,
                  "sources",
                )}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                返回来源与投递
              </RequestLink>
              {data.trace.some(
                (item) => item.informationId === sourceInformationId,
              ) && DetailComponent ? (
                <DetailComponent
                  token={token}
                  selected={sourceInformationId}
                  revision={revision}
                  select={(next) =>
                    navigate(
                      requestDetailPath(
                        module.definitionId,
                        requestId,
                        "sources",
                        next,
                      ),
                    )
                  }
                />
              ) : (
                <FieldMessage>
                  这条记录不在本次请求的可用关联集合中，请返回来源列表。
                </FieldMessage>
              )}
            </section>
          ) : (
            <RequestSources data={data} definitionId={module.definitionId} />
          )}
        </>
      )}
    </article>
  );
}
function RequestOverview({
  data,
  composer,
}: {
  data: InspectionRequestDetail;
  composer: boolean;
}) {
  return (
    <div className="request-overview">
      <section aria-labelledby="request-input-title">
        <h2 id="request-input-title">
          {data.request.triggerKind === "authorization"
            ? "授权发送要求"
            : "触发消息"}
          {data.inputs.length > 1 && <span> · {data.inputs.length} 条</span>}
        </h2>
        {data.inputs.map((input) => (
          <div key={input.informationId} className="request-input">
            <p>
              {input.sender && <strong>{input.sender}</strong>}
              {input.occurredAt && (
                <time dateTime={input.occurredAt}>
                  {displayDate(input.occurredAt)}
                </time>
              )}
            </p>
            <p>{input.text}</p>
          </div>
        ))}
        {!data.inputs.length && (
          <p className="request-trigger-note">
            {data.contextAvailable
              ? "本次请求没有冻结的入站消息。"
              : "触发上下文不可用，无法确认这次请求的入站消息。"}
          </p>
        )}
      </section>
      <section aria-labelledby="request-result-title">
        <h2 id="request-result-title">{composer ? "生成内容" : "决定动作"}</h2>
        <p className="request-result">
          {composer
            ? data.result.text ||
              data.request.outcomeText ||
              requestStatus(data.request.status)
            : data.request.outcomeText ||
              (data.result.action
                ? statusLabel(data.result.action)
                : requestStatus(data.request.status))}
        </p>
        {data.result.reason && (
          <p className="request-reason">{statusLabel(data.result.reason)}</p>
        )}
      </section>
    </div>
  );
}
function RequestSources({
  data,
  definitionId,
}: {
  data: InspectionRequestDetail;
  definitionId: string;
}) {
  return (
    <section className="request-sources" aria-label="请求来源与投递记录">
      {data.model && <InspectionFields fields={data.model} />}
      {data.trace.length ? (
        <ol className="request-trace">
          {data.trace.map((item) => (
            <li key={item.informationId}>
              <RequestLink
                path={requestDetailPath(
                  definitionId,
                  data.request.requestId,
                  "sources",
                  item.informationId,
                )}
              >
                <div>
                  <strong>{item.label}</strong>
                  <time dateTime={item.occurredAt}>
                    {displayDate(item.occurredAt)}
                  </time>
                  {item.status && <span>{requestStatus(item.status)}</span>}
                </div>
                <code>{item.kind}</code>
                <code>{item.informationId}</code>
              </RequestLink>
            </li>
          ))}
        </ol>
      ) : (
        <FieldMessage>尚无可读取的关联记录。</FieldMessage>
      )}
      {data.truncated && (
        <FieldMessage>
          关联记录已达到读取上限，当前列表可能不完整。
        </FieldMessage>
      )}
      <p className="request-id">
        请求 ID <code>{data.request.requestId}</code>
      </p>
    </section>
  );
}
