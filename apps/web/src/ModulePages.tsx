/**
 * 功能概述：检查区模块紧凑总览与独立详情页，展示内容直接取自 Inspection 的定义元数据。
 * 主要职责：moduleDetailPath/moduleDefinitionId 编解码稳定 ID；ModuleOverview 提供搜索和原生链接；
 * ModuleDetails 根据 Manifest 挂载逐模型请求页面或通用运行检查；请求详情独占内容区，技术元数据不叠加。
 * ModulePage 处理不可用和未找到，模块与请求深链接共用稳定 ID 解码。
 * 代码库关系：DeveloperConsole 传入已校验的模块数据和当前路径；ModuleLink 使用 AppShell 导航守卫；
 * ModuleEditorProps 仅将 definitionId/token 交给可选 SettingsSection/TemplatesSection，不预定义编辑 DTO。
 * 输入输出与副作用：只读展示，普通点击走工作台导航，修饰键和新标签保持浏览器行为；不保存 Token 或应用配置。
 */
import { ModuleTopology } from "./ModuleTopology.js";
import {
  ModuleRuntimeSection,
  type InspectionDetailProps,
} from "./ModuleRuntimeSection.js";
import { ModuleSurface } from "./ModuleSurface.js";
import { RequestSurface } from "./RequestSurface.js";
import { requestRoute } from "./request-routes.js";
import { LayoutGrid, GitBranch } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { InspectionModule } from "@kaguya/schema";
import { useWorkbenchNavigate } from "./components/AppShell.js";
import { FieldMessage, StatusBadge } from "./components/ui.js";

export function moduleDetailPath(definitionId: string): string {
  return `/developer/modules/${encodeURIComponent(definitionId)}`;
}
export function moduleDefinitionId(path: string): string | undefined {
  const request = requestRoute(path);
  if (request) return request.definitionId;
  const match = /^\/developer\/modules\/([^/]+)\/?$/.exec(path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}
export function navigateModuleLink(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    | "button"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "defaultPrevented"
    | "preventDefault"
  >,
  path: string,
  navigate: (path: string) => void,
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(path);
}
function ModuleLink({
  path,
  children,
  className,
}: {
  path: string;
  children: ReactNode;
  className?: string;
}) {
  const navigate = useWorkbenchNavigate();
  return (
    <a
      href={path}
      className={className}
      onClick={(event) => navigateModuleLink(event, path, navigate)}
    >
      {children}
    </a>
  );
}
function OverviewLink() {
  return <ModuleLink path="/developer/modules">返回模块总览</ModuleLink>;
}
export interface ModuleEditorProps {
  readonly definitionId: string;
  readonly token: string;
}
export interface ModuleDetailSections {
  readonly DetailComponent?: ComponentType<InspectionDetailProps>;
  readonly revision?: number;
  readonly SettingsSection?: ComponentType<ModuleEditorProps>;
  readonly TemplatesSection?: ComponentType<ModuleEditorProps>;
}
export function ModuleOverview({
  modules,
}: {
  modules: readonly InspectionModule[];
}) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"list" | "topology">("list");
  const visible = modules.filter((module) =>
    `${module.definitionId} ${module.displayName} ${module.summary}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <section aria-label="模块总览">
      <div className="module-summary-strip">
        <div>
          <strong>{modules.length}</strong>
          <span>可用定义</span>
        </div>
        <div>
          <strong>{modules.filter((m) => m.bindings.length > 0).length}</strong>
          <span>已激活模块</span>
        </div>
        <div className="module-view-switch" aria-label="模块视图">
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            列表
          </button>
          <button
            type="button"
            aria-pressed={view === "topology"}
            onClick={() => setView("topology")}
          >
            <GitBranch size={16} aria-hidden="true" />
            信息流
          </button>
        </div>
      </div>
      {view === "topology" ? (
        <ModuleTopology modules={modules} />
      ) : (
        <>
          <label className="developer-search">
            查找模块
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="名称或 definition ID"
            />
          </label>
          <p role="status">{visible.length} 个模块定义</p>
          {!modules.length ? (
            <FieldMessage>当前运行时没有可用的模块定义。</FieldMessage>
          ) : !visible.length ? (
            <FieldMessage>没有匹配的模块，请调整搜索条件。</FieldMessage>
          ) : null}
          <ul className="module-overview">
            {visible.map((module) => (
              <li key={module.definitionId}>
                <ModuleLink
                  path={moduleDetailPath(module.definitionId)}
                  className="module-entry"
                >
                  <div className="module-entry-copy">
                    <h2>{module.displayName}</h2>
                    <p title={module.summary}>{module.summary}</p>
                    <code>{module.definitionId}</code>
                  </div>
                  <div className="module-entry-meta">
                    <StatusBadge
                      tone={module.bindings.length ? "success" : "neutral"}
                    >
                      {module.bindings.length ? "已激活" : "未激活"}
                    </StatusBadge>
                    <span>
                      输入 {module.consumes.length} · 输出{" "}
                      {module.produces.length}
                    </span>
                  </div>
                </ModuleLink>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
export function ModuleDetails({
  module,
  token,
  SettingsSection,
  TemplatesSection,
  DetailComponent,
  revision = 0,
  path = moduleDetailPath(module.definitionId),
}: {
  module: InspectionModule;
  token: string;
  path?: string;
} & ModuleDetailSections) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [module.definitionId, path]);
  const requestBrowser = module.inspection?.surface?.components.find(
    (component) => component.type === "model-request-browser",
  );
  const isRequestDetail = requestRoute(path) !== undefined;
  if (isRequestDetail && !requestBrowser)
    return (
      <section>
        <FieldMessage>该模块没有声明模型请求检查页面。</FieldMessage>
        <OverviewLink />
      </section>
    );
  return (
    <article className="module-details">
      {!isRequestDetail && (
        <>
          <OverviewLink />
          <header>
            <h2 ref={heading} tabIndex={-1}>
              {module.displayName}
            </h2>
            <p>{module.summary}</p>
            <StatusBadge tone={module.bindings.length ? "success" : "neutral"}>
              {module.bindings.length ? "已激活" : "未激活"}
            </StatusBadge>
            <p>
              <code>{module.definitionId}</code>
            </p>
          </header>
        </>
      )}
      {requestBrowser ? (
        <RequestSurface
          module={module}
          browser={requestBrowser}
          token={token}
          revision={revision}
          path={path}
          DetailComponent={DetailComponent}
        />
      ) : (
        module.inspection &&
        DetailComponent &&
        (module.inspection.surface ? (
          <ModuleSurface
            module={module}
            token={token}
            revision={revision}
            DetailComponent={DetailComponent}
          />
        ) : (
          <ModuleRuntimeSection
            module={module}
            token={token}
            revision={revision}
            DetailComponent={DetailComponent}
          />
        ))
      )}
      {!isRequestDetail && (
        <>
          <details className="developer-card">
            <summary>模块职责与输入输出</summary>
            <section aria-label="模块职责">
              <h3>模块职责</h3>
              <p>{module.description}</p>
            </section>
            <div className="module-kind-columns">
              {(["consumes", "produces"] as const).map((field, index) => (
                <section
                  className="developer-card"
                  key={field}
                  aria-label={index ? "输出信息" : "输入信息"}
                >
                  <h3>
                    {index ? "输出信息" : "输入信息"} · {module[field].length}
                  </h3>
                  {module[field].length ? (
                    <ul className="module-kind-list">
                      {module[field].map((kind) => (
                        <li key={kind.kind}>
                          <details>
                            <summary>{kind.displayName}</summary>
                            <p>{kind.description}</p>
                            <code>{kind.kind}</code>
                          </details>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>没有声明{index ? "输出" : "输入"}信息。</p>
                  )}
                </section>
              ))}
            </div>
          </details>
          {SettingsSection && (
            <details className="developer-card" aria-label="模块配置">
              <summary>模块配置</summary>
              <SettingsSection
                definitionId={module.definitionId}
                token={token}
              />
            </details>
          )}
          {TemplatesSection && (
            <details className="developer-card" aria-label="提示词模板">
              <summary>提示词模板</summary>
              <TemplatesSection
                definitionId={module.definitionId}
                token={token}
              />
            </details>
          )}
          <details className="developer-card">
            <summary>Prompt renderer · {module.promptRenderers.length}</summary>
            {module.promptRenderers.length ? (
              module.promptRenderers.map((renderer) => (
                <section key={renderer.rendererId}>
                  <h3>{renderer.displayName}</h3>
                  <p>{renderer.description}</p>
                  <code>{renderer.rendererId}</code>
                  <p>{renderer.kinds.join("、")}</p>
                </section>
              ))
            ) : (
              <p>没有声明 Prompt renderer。</p>
            )}
          </details>
          <details className="developer-card">
            <summary>Selector、Capability、绑定与诊断</summary>
            <dl className="inspection-fields">
              <div>
                <dt>模块 / 协议版本</dt>
                <dd>
                  {module.moduleVersion} / {module.protocolVersion}
                </dd>
              </div>
              <div>
                <dt>上下文选择器</dt>
                <dd>{module.selectors.join("、") || "无"}</dd>
              </div>
              <div>
                <dt>所需能力</dt>
                <dd>
                  {module.requires
                    .map((c) => `${c.id} · v${c.apiVersion}`)
                    .join("、") || "无"}
                </dd>
              </div>
              <div>
                <dt>提供能力</dt>
                <dd>
                  {module.provides
                    .map((c) => `${c.id} · v${c.apiVersion}`)
                    .join("、") || "无"}
                </dd>
              </div>
              <div>
                <dt>实例绑定</dt>
                <dd>
                  {module.bindings.map((b) => (
                    <section key={b.instanceId}>
                      <code>{b.instanceId}</code>
                      <ul>
                        {b.capabilities.map((c) => (
                          <li key={c.capabilityId}>
                            {c.capabilityId} → {c.provider}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </dd>
              </div>
              <div>
                <dt>诊断事件声明</dt>
                <dd>{module.diagnostics.join("、") || "无"}</dd>
              </div>
              <div>
                <dt>设置 schema 指纹</dt>
                <dd>
                  <code>{module.settingsSchemaFingerprint}</code>
                </dd>
              </div>
            </dl>
          </details>
        </>
      )}
    </article>
  );
}
export function ModulePage({
  path,
  token,
  state,
  ...sections
}: {
  path: string;
  token: string;
  state: { data?: { modules: InspectionModule[] }; error?: string };
} & ModuleDetailSections) {
  const definitionId = moduleDefinitionId(path);
  if (state.error)
    return (
      <section>
        <FieldMessage tone="error">
          模块检查暂不可用：{state.error}
        </FieldMessage>
        <OverviewLink />
      </section>
    );
  if (!state.data)
    return (
      <section>
        <FieldMessage>正在加载模块…</FieldMessage>
        {definitionId !== undefined && <OverviewLink />}
      </section>
    );
  if (definitionId === undefined)
    return <ModuleOverview modules={state.data.modules} />;
  const module = state.data.modules.find(
    (item) => item.definitionId === definitionId,
  );
  if (!module)
    return (
      <section>
        <FieldMessage>
          {state.data.modules.length
            ? "未找到该模块，定义可能已移除。"
            : "当前运行时没有可用的模块定义。"}
        </FieldMessage>
        <OverviewLink />
      </section>
    );
  return (
    <ModuleDetails
      key={module.definitionId}
      module={module}
      token={token}
      path={path}
      {...sections}
    />
  );
}
