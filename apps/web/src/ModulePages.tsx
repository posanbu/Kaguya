/**
 * 功能概述：检查区模块紧凑总览与独立详情页，展示内容直接取自 Inspection 的定义元数据。
 * 主要职责：moduleDetailPath/moduleDefinitionId 编解码稳定 ID；ModuleOverview 提供搜索和原生链接；
 * ModuleDetails 展示职责与输入输出并折叠技术信息，ModulePage 统一处理加载、不可用、空列表和未找到。
 * 代码库关系：DeveloperConsole 传入已校验的模块数据和当前路径；ModuleLink 使用 AppShell 导航守卫；
 * ModuleEditorProps 仅将 definitionId/token 交给可选 SettingsSection/TemplatesSection，不预定义编辑 DTO。
 * 输入输出与副作用：只读展示，普通点击走工作台导航，修饰键和新标签保持浏览器行为；不保存 Token 或应用配置。
 */
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
  readonly SettingsSection?: ComponentType<ModuleEditorProps>;
  readonly TemplatesSection?: ComponentType<ModuleEditorProps>;
}
export function ModuleOverview({
  modules,
}: {
  modules: readonly InspectionModule[];
}) {
  const [search, setSearch] = useState("");
  const visible = modules.filter((module) =>
    `${module.definitionId} ${module.displayName} ${module.summary}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <section aria-label="模块总览">
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
                  输入 {module.consumes.length} · 输出 {module.produces.length}
                </span>
              </div>
            </ModuleLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
export function ModuleDetails({
  module,
  token,
  SettingsSection,
  TemplatesSection,
}: { module: InspectionModule; token: string } & ModuleDetailSections) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [module.definitionId]);
  return (
    <article className="module-details">
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
      <section aria-label="模块职责" className="developer-card">
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
                    <h4>{kind.displayName}</h4>
                    <p>{kind.description}</p>
                    <code>{kind.kind}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>没有声明{index ? "输出" : "输入"}信息。</p>
            )}
          </section>
        ))}
      </div>
      {SettingsSection && (
        <section className="developer-card" aria-label="模块配置">
          <h3>模块配置</h3>
          <SettingsSection definitionId={module.definitionId} token={token} />
        </section>
      )}
      {TemplatesSection && (
        <section className="developer-card" aria-label="提示词模板">
          <h3>提示词模板</h3>
          <TemplatesSection definitionId={module.definitionId} token={token} />
        </section>
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
        <pre>
          {JSON.stringify(
            {
              moduleVersion: module.moduleVersion,
              protocolVersion: module.protocolVersion,
              selectors: module.selectors,
              requires: module.requires,
              provides: module.provides,
              bindings: module.bindings,
              diagnostics: module.diagnostics,
              settingsSchemaFingerprint: module.settingsSchemaFingerprint,
            },
            null,
            2,
          )}
        </pre>
      </details>
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
      {...sections}
    />
  );
}
