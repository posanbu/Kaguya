/**
 * 功能概述：以 Obsidian 风格的小圆点和细线呈现可交互的力导向记忆图。
 * 主要职责：按标签／出现时间／当前图关系数着色并展示图例；悬停或选中用外圈突出节点，保留分组色。
 * 代码库关系：复用 react-force-graph 的 MIT 高亮与曲线示例；出处见 THIRD_PARTY_NOTICES.md。
 * MemoryGraph 提供持久化快照和操作回调，memory-graph-model 为图引擎创建可修改的副本。
 * 输入输出与副作用：只维护视图和模拟坐标；不发起数据库写入，卸载后取消观察器与模拟。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Focus, Link2, Minus, Plus, Type } from "lucide-react";
import type { MemoryGraphSnapshot } from "@kaguya/schema";
import { Button } from "./components/ui.js";
import {
  memoryColorEncoding,
  type MemoryColorMode,
} from "./memory-graph-colors.js";
import {
  graphEndpointId,
  memoryForceData,
  type MemoryGraphDot,
  type MemoryGraphLine,
} from "./memory-graph-model.js";

const shortTitle = (title: string) =>
  Array.from(title).length > 16
    ? Array.from(title).slice(0, 16).join("") + "…"
    : title;
export function MemoryGraphCanvas({
  snapshot,
  selectedId,
  selectedEdgeId,
  onNode,
  onEdge,
  onConnect,
  disabled = false,
  colorMode,
  onColorMode,
}: {
  snapshot: MemoryGraphSnapshot;
  selectedId?: string;
  selectedEdgeId?: string;
  onNode: (id: string) => void;
  onEdge: (id: string) => void;
  onConnect: (connection: { source: string; target: string }) => void;
  disabled?: boolean;
  colorMode: MemoryColorMode;
  onColorMode: (mode: MemoryColorMode) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<
    ForceGraphMethods<MemoryGraphDot, MemoryGraphLine> | undefined
  >(undefined);
  const data = useMemo(() => memoryForceData(snapshot), [snapshot]);
  const [size, setSize] = useState({ width: 1, height: 480 });
  const [hoverNode, setHoverNode] = useState<MemoryGraphDot | null>(null);
  const [hoverLink, setHoverLink] = useState<MemoryGraphLine | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkSource, setLinkSource] = useState<string>();
  const [labels, setLabels] = useState(true);
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [colors, setColors] = useState({
    node: "#807d89",
    line: "#cbc8d2",
    focus: "#8b68cc",
    ink: "#55515f",
    dim: "#e0dde5",
    surface: "#faf9fb",
    dark: false,
  });
  const observedAt = useMemo(() => Date.now(), [snapshot]);
  const encoding = useMemo(
    () => memoryColorEncoding(snapshot, colorMode, observedAt, colors.dark),
    [snapshot, colorMode, observedAt, colors.dark],
  );
  const needsFit = useRef(true);
  const fit = useCallback(() => {
    const instance = graph.current;
    if (!instance) return;
    instance.zoomToFit(0, 80);
    instance.zoom(Math.min(instance.zoom(), 1.6), 0);
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: Math.max(1, Math.floor(entry.contentRect.width)),
        height: Math.max(1, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    const updateColors = () => {
      const style = getComputedStyle(element);
      setColors({
        node: style.getPropertyValue("--memory-node").trim(),
        line: style.getPropertyValue("--memory-line").trim(),
        focus: style.getPropertyValue("--memory-focus").trim(),
        ink: style.getPropertyValue("--memory-ink").trim(),
        dim: style.getPropertyValue("--memory-dim").trim(),
        surface: style.getPropertyValue("--memory-surface").trim(),
        dark: document.documentElement.dataset.theme === "dark",
      });
    };
    updateColors();
    const theme = new MutationObserver(updateColors);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      observer.disconnect();
      theme.disconnect();
    };
  }, []);
  useEffect(() => {
    needsFit.current = true;
    graph.current?.d3Force("charge")?.strength(-140);
    graph.current?.d3Force("link")?.distance(110);
  }, [data]);
  useEffect(() => {
    if (size.width > 1) fit();
  }, [size, fit]);
  const focusedLink =
    hoverLink ?? data.links.find((link) => link.id === selectedEdgeId);
  const focusedNode = focusedLink
    ? undefined
    : (hoverNode?.id ?? linkSource ?? selectedId);
  const neighbors = new Set<string>();
  if (focusedLink) {
    neighbors.add(graphEndpointId(focusedLink.source));
    neighbors.add(graphEndpointId(focusedLink.target));
  } else if (focusedNode) {
    neighbors.add(focusedNode);
    data.links.forEach((link) => {
      const a = graphEndpointId(link.source),
        b = graphEndpointId(link.target);
      if (a === focusedNode || b === focusedNode) {
        neighbors.add(a);
        neighbors.add(b);
      }
    });
  }
  const isActiveLink = (link: MemoryGraphLine) =>
    focusedLink
      ? link.id === focusedLink.id
      : !!focusedNode &&
        (graphEndpointId(link.source) === focusedNode ||
          graphEndpointId(link.target) === focusedNode);
  const drawNode = (
    node: MemoryGraphDot,
    ctx: CanvasRenderingContext2D,
    scale: number,
  ) => {
    const current = node.id === focusedNode || node.id === selectedId;
    const related = neighbors.has(node.id);
    const dimmed = neighbors.size > 0 && !related;
    const radius = (current ? 5 : 3.3) / scale;
    ctx.save();
    ctx.globalAlpha = dimmed ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = encoding.nodes.get(node.id)?.color ?? colors.node;
    ctx.fill();
    if (current) {
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius + 2.5 / scale, 0, 2 * Math.PI);
      ctx.strokeStyle = colors.focus;
      ctx.lineWidth = 1.4 / scale;
      ctx.stroke();
    }
    if (labels && !dimmed && (scale >= 0.8 || current)) {
      ctx.font = `${11 / scale}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = current ? colors.focus : colors.ink;
      ctx.fillText(
        shortTitle(node.title),
        node.x ?? 0,
        (node.y ?? 0) + radius + 6 / scale,
      );
    }
    ctx.restore();
  };
  return (
    <div className="memory-graph-frame">
      <div className="memory-colorbar">
        <label>
          节点颜色
          <select
            aria-label="节点颜色"
            value={colorMode}
            onChange={(event) =>
              onColorMode(event.target.value as MemoryColorMode)
            }
          >
            <option value="tag">首个标签</option>
            <option value="time">出现时间</option>
            <option value="degree">当前图关系条数</option>
          </select>
        </label>
        <ul className="memory-color-legend" aria-label="节点颜色图例">
          {encoding.groups.map((group) => (
            <li key={group.key}>
              <span
                aria-hidden="true"
                style={{ backgroundColor: group.color }}
              />
              <span>{group.label}</span>
              <span className="memory-legend-count">{group.count}</span>
            </li>
          ))}
        </ul>
      </div>
      <div
        className={`memory-canvas${linking ? " memory-canvas-linking" : ""}`}
        ref={container}
        role="region"
        aria-label="记忆关联图：小圆点表示节点，细线表示关系。可用右侧节点列表进行键盘选择。"
      >
        <ForceGraph2D<MemoryGraphDot, MemoryGraphLine>
          ref={graph}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor={colors.surface}
          nodeRelSize={3.3}
          nodeVal={1}
          nodeLabel={() => ""}
          linkLabel={() => ""}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node, color, ctx, scale) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, 12 / scale, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={(link) =>
            neighbors.size > 0
              ? isActiveLink(link)
                ? colors.focus
                : colors.dim
              : colors.line
          }
          linkWidth={(link) => (isActiveLink(link) ? 1.4 : 0.65)}
          linkCurvature="curvature"
          linkHoverPrecision={8}
          linkDirectionalArrowLength={(link) => (isActiveLink(link) ? 3.5 : 0)}
          linkDirectionalArrowRelPos={0.9}
          onNodeHover={(node) => {
            setHoverNode(node);
            setHoverLink(null);
          }}
          onLinkHover={(link) => {
            setHoverLink(link);
            setHoverNode(null);
          }}
          onNodeClick={(node) => {
            if (disabled) return;
            if (linking) {
              if (!linkSource) setLinkSource(node.id);
              else {
                onConnect({ source: linkSource, target: node.id });
                setLinkSource(undefined);
                setLinking(false);
              }
            } else onNode(node.id);
          }}
          onLinkClick={(link) => {
            if (!disabled) onEdge(link.id);
          }}
          enableNodeDrag={!disabled && !linking}
          enablePointerInteraction={!disabled}
          minZoom={0.15}
          maxZoom={5}
          warmupTicks={100}
          cooldownTicks={reducedMotion ? 0 : 45}
          onEngineStop={() => {
            if (needsFit.current) {
              needsFit.current = false;
              fit();
            }
          }}
        />
        <div className="memory-graph-tools" aria-label="图工具">
          <Button
            aria-label="放大"
            onClick={() =>
              graph.current?.zoom((graph.current?.zoom() ?? 1) * 1.25, 0)
            }
          >
            <Plus size={16} />
          </Button>
          <Button
            aria-label="缩小"
            onClick={() =>
              graph.current?.zoom((graph.current?.zoom() ?? 1) / 1.25, 0)
            }
          >
            <Minus size={16} />
          </Button>
          <Button aria-label="适应全部节点" onClick={fit}>
            <Focus size={16} />
          </Button>
          <Button
            aria-label="显示节点标签"
            aria-pressed={labels}
            onClick={() => setLabels(!labels)}
          >
            <Type size={16} />
          </Button>
          <Button
            disabled={disabled}
            aria-pressed={linking}
            onClick={() => {
              setLinking(!linking);
              setLinkSource(undefined);
            }}
          >
            <Link2 size={16} />
            {linking ? "取消连线" : "连线"}
          </Button>
        </div>
        {linking && (
          <div className="memory-graph-mode" role="status">
            {linkSource ? "再点选终点" : "先点选起点"}
          </div>
        )}
        {(hoverNode || hoverLink) && (
          <div className="memory-graph-tooltip" aria-live="polite">
            {hoverNode ? (
              <>
                <strong>{hoverNode.title}</strong>
                <span>{hoverNode.tags.join(" · ")}</span>
                <span>
                  {colorMode === "tag"
                    ? "首个标签"
                    : colorMode === "time"
                      ? "出现时间"
                      : "当前图关系条数"}
                  ：{encoding.nodes.get(hoverNode.id)?.label}
                </span>
              </>
            ) : (
              <strong>{hoverLink?.relation}</strong>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
