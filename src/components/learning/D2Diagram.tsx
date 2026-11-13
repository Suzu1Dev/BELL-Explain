import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, Code2, Network } from "lucide-react";
import { parseD2, type D2Node } from "../../../shared/d2";
import type { D2Diagram as D2DiagramData } from "../../../shared/lesson-v3";
import { fill, learningCopy } from "../../copy/learning";
import FigureFrame from "./FigureFrame";
import V3Text from "./V3Text";

interface StageColumn {
  id: string;
  label?: string;
  nodes: D2Node[];
}

interface WirePath {
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active: boolean;
}

interface LocalBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function measureLocalBox(el: HTMLElement, ancestor: HTMLElement): LocalBox {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== ancestor) {
    x += cur.offsetLeft + (cur === el ? 0 : cur.clientLeft);
    y += cur.offsetTop + (cur === el ? 0 : cur.clientTop);
    cur = cur.offsetParent as HTMLElement | null;
  }
  return {
    left: x,
    top: y,
    right: x + el.offsetWidth,
    bottom: y + el.offsetHeight,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

function buildColumns(source: string): { direction: "right" | "down"; columns: StageColumn[]; graph: ReturnType<typeof parseD2> } {
  const graph = parseD2(source);
  if (graph.groups.length > 0) {
    const columns: StageColumn[] = graph.groups.map(group => ({ id: group.id, label: group.label, nodes: group.nodes }));
    if (graph.nodes.length > 0) columns.push({ id: "__standalone", nodes: graph.nodes });
    return { direction: graph.direction, columns, graph };
  }
  if (graph.direction === "down" || graph.allNodes.length <= 1) {
    return { direction: graph.direction, columns: [{ id: "__flow", nodes: graph.allNodes }], graph };
  }
  const rank = new Map<string, number>(graph.allNodes.map(node => [node.id, 0]));
  for (let pass = 0; pass < Math.min(3, graph.allNodes.length); pass++) {
    for (const edge of graph.edges) {
      const fromRank = rank.get(edge.from) ?? 0;
      const toRank = rank.get(edge.to) ?? 0;
      if (fromRank >= toRank && edge.from !== edge.to) rank.set(edge.to, Math.min(2, fromRank + 1));
    }
  }
  const buckets = new Map<number, D2Node[]>();
  for (const node of graph.allNodes) {
    const col = rank.get(node.id) ?? 0;
    const list = buckets.get(col) ?? [];
    list.push(node);
    buckets.set(col, list);
  }
  const columns = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([col, nodes]) => ({ id: `__col_${col}`, nodes }));
  return { direction: graph.direction, columns, graph };
}

export default function D2Diagram({ figure, interactive = true }: { figure: D2DiagramData; interactive?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const { direction, columns, graph } = useMemo(() => buildColumns(figure.source), [figure.source]);
  const [current, setCurrent] = useState(1);
  const [view3D, setView3D] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [wires, setWires] = useState<{ width: number; height: number; paths: WirePath[] }>({ width: 0, height: 0, paths: [] });
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrent(value => Math.max(1, Math.min(Math.max(1, graph.edges.length), value)));
  }, [graph.edges.length]);

  const stepper = interactive && graph.edges.length > 1 ? { current, total: graph.edges.length, setCurrent } : undefined;
  const activeIndex = graph.edges.length > 0 ? Math.min(graph.edges.length - 1, current - 1) : -1;
  const activeEdge = activeIndex >= 0 ? graph.edges[activeIndex] : undefined;
  const nodeById = useMemo(() => new Map(graph.allNodes.map(node => [node.id, node])), [graph.allNodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width < 10 || height < 10) {
        setWires({ width: 0, height: 0, paths: [] });
        return;
      }
      const rects = new Map<string, LocalBox>();
      canvas.querySelectorAll<HTMLElement>("[data-d2-node]").forEach(el => {
        const id = el.getAttribute("data-d2-node");
        if (id) rects.set(id, measureLocalBox(el, canvas));
      });
      const paths: WirePath[] = [];
      graph.edges.forEach((edge, index) => {
        const a = rects.get(edge.from);
        const b = rects.get(edge.to);
        if (!a || !b) return;
        const active = index === activeIndex;
        const lift = active && view3D ? -2 : 0;
        if (b.left >= a.right - 8) {
          const x1 = a.right, y1 = a.top + a.height / 2 + lift;
          const x2 = b.left, y2 = b.top + b.height / 2 + lift;
          const dx = Math.max(22, Math.abs(x2 - x1) * 0.5);
          paths.push({ d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, x1, y1, x2, y2, active });
        } else if (a.left >= b.right - 8) {
          const x1 = a.left, y1 = a.top + a.height * 0.66 + lift;
          const x2 = b.right, y2 = b.top + b.height * 0.66 + lift;
          const dx = Math.max(22, Math.abs(x1 - x2) * 0.5);
          paths.push({ d: `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`, x1, y1, x2, y2, active });
        } else if (b.top >= a.bottom - 4) {
          const x1 = a.left + a.width / 2, y1 = a.bottom + lift;
          const x2 = b.left + b.width / 2, y2 = b.top + lift;
          const dy = Math.max(14, Math.abs(y2 - y1) * 0.5);
          paths.push({ d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, x1, y1, x2, y2, active });
        } else {
          const x1 = a.right, y1 = a.top + a.height / 2 + lift;
          const x2 = b.right, y2 = b.top + b.height / 2 + lift;
          const arc = Math.max(x1, x2) + 18;
          paths.push({ d: `M ${x1} ${y1} C ${arc} ${y1}, ${arc} ${y2}, ${x2} ${y2}`, x1, y1, x2, y2, active });
        }
      });
      paths.sort((p, q) => Number(p.active) - Number(q.active));
      setWires({ width, height, paths });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [graph, activeIndex, showSource, view3D]);

  const copy = learningCopy().figures;
  const heading = figure.title || copy.kinds.d2;
  const stacked = direction === "down" || columns.length <= 1 || columns.length > 3;

  return (
    <FigureFrame
      title={figure.title ? <V3Text text={figure.title} sourceKey="figure:d2-title" /> : copy.kinds.d2}
      icon={Network}
      stepper={stepper}
      caption={figure.caption ? <V3Text text={figure.caption} sourceKey="figure:d2-caption" /> : undefined}
      ariaLabel={fill(stepper ? copy.d2.regionAria : copy.d2.regionStaticAria, { title: heading })}
      actions={interactive ? (
        <>
          <button
            type="button"
            className={`v3-d2-source-btn${view3D ? " is-open" : ""}`}
            aria-pressed={view3D}
            aria-label={copy.d2.toggle3dAria}
            title={copy.d2.toggle3dAria}
            onClick={() => setView3D(value => !value)}
          >
            <Box size={13} aria-hidden="true" /><span>3D</span>
          </button>
          <button
            type="button"
            className={`v3-d2-source-btn${showSource ? " is-open" : ""}`}
            aria-pressed={showSource}
            aria-label={showSource ? copy.d2.hideSourceAria : copy.d2.showSourceAria}
            title={showSource ? copy.d2.hideSourceAria : copy.d2.showSourceAria}
            onClick={() => setShowSource(value => !value)}
          >
            <Code2 size={13} aria-hidden="true" /><span>D2</span>
          </button>
        </>
      ) : undefined}
    >
      <div className="v3-figure-body v3-d2-body">
        <div className={`v3-d2-stage${view3D ? " is-3d" : ""}`}>
          <svg className="v3-d2-floor" aria-hidden="true">
            <defs>
              <pattern id={`${uid}-grid`} width="22" height="22" patternUnits="userSpaceOnUse">
                <path d="M 22 0 L 0 0 0 22" fill="none" stroke="var(--line)" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${uid}-grid)`} />
          </svg>
          <div
            ref={canvasRef}
            className={`v3-d2-canvas${stacked ? " is-stacked" : ""}${view3D ? " is-3d" : ""}`}
            style={{ "--v3-d2-cols": Math.min(3, Math.max(1, columns.length)) } as React.CSSProperties}
          >
            {wires.width > 0 && wires.paths.length > 0 && (
              <svg className="v3-d2-wires" viewBox={`0 0 ${wires.width} ${wires.height}`} aria-hidden="true">
                <defs>
                  <marker id={`${uid}-idle`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--text-3)" />
                  </marker>
                  <marker id={`${uid}-active`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--v3-mark)" />
                  </marker>
                </defs>
                {wires.paths.map((wire, index) => (
                  <g key={index} className={wire.active ? "is-active" : "is-idle"}>
                    <path d={wire.d} markerEnd={`url(#${uid}-${wire.active ? "active" : "idle"})`} />
                    {wire.active && (
                      <>
                        <rect x={wire.x1 - 3} y={wire.y1 - 3} width="6" height="6" rx="1" />
                        <rect className="is-dest-port" x={wire.x2 - 2.5} y={wire.y2 - 2.5} width="5" height="5" rx="1" />
                      </>
                    )}
                  </g>
                ))}
              </svg>
            )}
            {columns.map((col, colIndex) => (
              <div className={`v3-d2-group${col.label ? "" : " is-plain"}`} key={col.id}>
                {col.label && (
                  <div className="v3-d2-group-head">
                    <span className="v3-d2-group-index">{String(colIndex + 1).padStart(2, "0")}</span>
                    <span className="v3-d2-group-title"><V3Text text={col.label} sourceKey={`figure:d2-group:${colIndex}`} /></span>
                  </div>
                )}
                <div className="v3-d2-nodes">
                  {col.nodes.map(node => {
                    const isSource = activeEdge?.from === node.id;
                    const isTarget = activeEdge?.to === node.id;
                    const linkedEdgeIndex = graph.edges.findIndex(edge => edge.from === node.id || edge.to === node.id);
                    return (
                      <div
                        key={node.id}
                        data-d2-node={node.id}
                        className={`v3-d2-node${isSource ? " is-source" : ""}${isTarget ? " is-target" : ""}`}
                        onClick={interactive && linkedEdgeIndex >= 0 ? () => setCurrent(linkedEdgeIndex + 1) : undefined}
                      >
                        <strong className="v3-d2-node-title"><V3Text text={node.title} sourceKey={`figure:d2-node-title:${node.id}`} /></strong>
                        {node.detail && <span className="v3-d2-node-detail"><V3Text text={node.detail} sourceKey={`figure:d2-node-detail:${node.id}`} /></span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {graph.edges.length > 0 && (
          <div className="v3-d2-edges" role="list">
            {graph.edges.map((edge, index) => {
              const fromNode = nodeById.get(edge.from);
              const toNode = nodeById.get(edge.to);
              const isActive = index === activeIndex;
              return (
                <button
                  type="button"
                  role="listitem"
                  key={index}
                  className={`v3-d2-edge${isActive ? " is-active" : ""}`}
                  aria-current={isActive ? "step" : undefined}
                  onClick={interactive ? () => setCurrent(index + 1) : undefined}
                >
                  <span className="v3-pin">{index + 1}</span>
                  <span className="v3-d2-endpoint"><V3Text text={fromNode?.title ?? edge.from} sourceKey={`figure:d2-edge-from:${index}`} /></span>
                  <span className="v3-d2-arrow" aria-hidden="true">{edge.bidirectional ? "↔" : "→"}</span>
                  <span className="v3-d2-endpoint is-dest"><V3Text text={toNode?.title ?? edge.to} sourceKey={`figure:d2-edge-to:${index}`} /></span>
                  {edge.label && <span className="v3-d2-edge-label"><V3Text text={edge.label} sourceKey={`figure:d2-edge-label:${index}`} /></span>}
                </button>
              );
            })}
          </div>
        )}

        {showSource && (
          <pre className="v3-d2-source" aria-label="D2 source"><code>{figure.source}</code></pre>
        )}
      </div>
    </FigureFrame>
  );
}
