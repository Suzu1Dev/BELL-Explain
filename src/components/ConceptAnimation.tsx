import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  RotateCcw,
  Terminal,
  Waypoints,
} from "lucide-react";
import type { Visual, VisualNode } from "../../shared/types";
import "./animation.css";
import MathText, { ProseBlocks } from "./MathText";
import SceneAnimation from "./SceneAnimation";

interface Props {
  visual: Visual;
  step: number;
  onStepChange: (step: number) => void;
  compact?: boolean;
  curated?: boolean;
  /** Ask for a prediction before showing what each step changes. */
  predict?: boolean;
}

interface Position {
  x: number;
  y: number;
}

const templateNodeIds = {
  closure: ["factory", "environment", "counter", "another"],
  "event-loop": ["stack", "microtasks", "timer", "console"],
  debounce: ["input", "closure", "timer", "search"],
};

function normalizeVisual(visual: Visual, curated: boolean): Visual {
  if (curated && visual.kind !== "flow") {
    const expectedIds = templateNodeIds[visual.kind];
    const validTemplate =
      visual.nodes.length === expectedIds.length &&
      new Set(visual.nodes.map((node) => node.id)).size ===
        expectedIds.length &&
      visual.nodes.every((node) => expectedIds.includes(node.id));
    if (validTemplate) {
      return {
        ...visual,
        nodes: [...visual.nodes].sort(
          (a, b) => expectedIds.indexOf(a.id) - expectedIds.indexOf(b.id),
        ),
      };
    }
  }
  // Semantic templates are reserved for verified examples; generated lessons use ordered stages.
  return visual.kind === "flow" ? visual : { ...visual, kind: "flow" };
}

function diagramNodeWidth(node: VisualNode, minimum: number) {
  const textWidth = Array.from(node.label).reduce(
    (width, character) => width + (/[\u3400-\u9fff]/.test(character) ? 20 : 10),
    0,
  );
  return Math.max(minimum, Math.ceil(textWidth + 16));
}

function positions(kind: Visual["kind"], count: number): Position[] {
  if (kind === "closure") {
    return Array.from({ length: count }, (_, i) => ({
      x: i % 2 ? 270 : 112,
      y: 89 + Math.floor(i / 2) * 67,
    }));
  }
  if (kind === "event-loop") {
    const layout = [
      { x: 105, y: 69 },
      { x: 279, y: 69 },
      { x: 279, y: 192 },
      { x: 105, y: 192 },
      { x: 192, y: 131 },
      { x: 192, y: 251 },
    ];
    return layout.slice(0, count);
  }
  if (kind === "debounce") {
    return Array.from({ length: count }, (_, i) => ({
      x: i % 2 ? 276 : 108,
      y: 115 + Math.floor(i / 2) * 61,
    }));
  }
  if (count === 1) return [{ x: 192, y: 132 }];
  if (count === 2)
    return [
      { x: 192, y: 89 },
      { x: 192, y: 192 },
    ];
  if (count === 4)
    return [
      { x: 105, y: 83 },
      { x: 279, y: 83 },
      { x: 279, y: 195 },
      { x: 105, y: 195 },
    ];
  if (count <= 3)
    return Array.from({ length: count }, (_, i) => ({
      x: 192,
      y: 49 + i * 83,
    }));
  return Array.from({ length: count }, (_, i) => ({
    x: (i < 3 ? i : 5 - i) * 121 + 71,
    y: i < 3 ? 83 : 195,
  }));
}

function linkPath(
  from: Position,
  to: Position,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
) {
  if (Math.abs(from.y - to.y) < 1) {
    const direction = Math.sign(to.x - from.x);
    return `M ${from.x + (direction * fromWidth) / 2} ${from.y} L ${to.x - direction * (toWidth / 2 + 7)} ${to.y}`;
  }
  if (Math.abs(from.x - to.x) < 1) {
    const direction = Math.sign(to.y - from.y);
    return `M ${from.x} ${from.y + (direction * fromHeight) / 2} L ${to.x} ${to.y - direction * (toHeight / 2 + 7)}`;
  }
  const middle = (from.y + to.y) / 2;
  const direction = Math.sign(to.y - from.y);
  return `M ${from.x} ${from.y + (direction * fromHeight) / 2} C ${from.x} ${middle}, ${to.x} ${middle}, ${to.x} ${to.y - direction * (toHeight / 2 + 7)}`;
}

function DiagramNode({
  node,
  position,
  active,
  width,
  height,
}: {
  node: VisualNode;
  position: Position;
  active: boolean;
  width: number;
  height: number;
}) {
  return (
    <g
      className={`viz-node ${active ? "viz-node-active" : ""}`}
      transform={`translate(${position.x}, ${position.y})`}
    >
      <title>{`${node.label}: ${node.detail}`}</title>
      <rect
        className="viz-node-halo"
        x={-width / 2 - 4}
        y={-height / 2 - 4}
        width={width + 8}
        height={height + 8}
        rx="15"
      />
      <rect
        className="viz-node-surface"
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx="11"
      />
      <text
        className={`viz-node-label${/[\u3400-\u9fff]/.test(node.label) ? " viz-node-label-cjk" : ""}`}
        textAnchor="middle"
        y="4"
      >
        {node.label}
      </text>
    </g>
  );
}

function LegacyAnimation({
  visual: suppliedVisual,
  step,
  onStepChange,
  compact = false,
  curated = false,
  predict = false,
}: Props) {
  const visual = useMemo(
    () => normalizeVisual(suppliedVisual, curated),
    [suppliedVisual, curated],
  );
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const total = visual.steps.length;
  const currentStep = Math.max(
    0,
    Math.min(
      Number.isFinite(step) ? Math.floor(step) : 0,
      Math.max(total - 1, 0),
    ),
  );
  const current = visual.steps[currentStep];
  const nodes = visual.nodes.slice(0, 6);
  const counterLayout: Record<string, Position> = {
    factory: { x: 192, y: 50 },
    environment: { x: 107, y: 134 },
    counter: { x: 107, y: 209 },
    another: { x: 279, y: 170 },
  };
  const counterClosure =
    visual.kind === "closure" &&
    nodes.length === 4 &&
    nodes.every((node) => node.id in counterLayout);
  const layout = counterClosure
    ? nodes.map((node) => counterLayout[node.id])
    : positions(visual.kind, nodes.length);
  const active = new Set(current?.activeNodeIds || []);
  const progress = total > 1 ? currentStep / (total - 1) : 1;
  const minimumNodeWidth = visual.kind === "flow" && nodes.length > 4 ? 105 : 132;
  const nodeWidths = nodes.map((node) => diagramNodeWidth(node, minimumNodeWidth));
  const nodeHeight = visual.kind === "event-loop" ? 60 : 48;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReducedMotion(media.matches);
      if (media.matches) setPlaying(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Steps are revealed one by one in predict mode; a refreshed copy of the same note keeps them.
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const stepsKey = useMemo(() => JSON.stringify(visual.steps), [visual]);
  const masked = predict && !playing && currentStep > 0 && !revealed.has(currentStep);
  const reveal = () => setRevealed((set) => new Set(set).add(currentStep));
  useEffect(() => {
    setPlaying(false);
    setRevealed(new Set());
  }, [stepsKey]);
  useEffect(() => {
    if (playing) setRevealed((set) => (set.has(currentStep) ? set : new Set(set).add(currentStep)));
  }, [playing, currentStep]);

  useEffect(() => {
    if (!playing || reducedMotion || total < 2) return;
    if (currentStep >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => onStepChange(currentStep + 1),
      2400 / speed,
    );
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, total, currentStep, speed, onStepChange]);

  function seek(next: number) {
    setPlaying(false);
    onStepChange(Math.max(0, Math.min(next, total - 1)));
  }

  function togglePlayback() {
    if (reducedMotion) {
      seek(currentStep >= total - 1 ? 0 : currentStep + 1);
      return;
    }
    if (!playing && currentStep >= total - 1) onStepChange(0);
    setPlaying((value) => !value);
  }

  const edgePairs: [number, number][] = counterClosure
    ? [
        ["factory", "environment"],
        ["environment", "counter"],
        ["factory", "another"],
      ].map(([from, to]) => [
        nodes.findIndex((node) => node.id === from),
        nodes.findIndex((node) => node.id === to),
      ])
    : visual.kind === "event-loop"
      ? nodes.slice(1).map((_, index) => [0, index + 1])
      : nodes.slice(1).map((_, index) => [index, index + 1]);
  const directed = visual.kind === "flow" || visual.kind === "debounce";
  const links = edgePairs.map(([from, to]) => ({
    key: `${nodes[from].id}-${nodes[to].id}`,
    path: linkPath(
      layout[from],
      layout[to],
      nodeWidths[from],
      nodeHeight,
      nodeWidths[to],
      nodeHeight,
    ),
    active:
      active.has(nodes[to].id) && (directed || active.has(nodes[from].id)),
  }));

  return (
    <section
      className={`viz-card ${compact ? "viz-compact" : ""} ${playing ? "viz-is-playing" : ""}`}
      aria-label={visual.title}
      data-step={currentStep}
      data-template={visual.kind}
    >
      <header className="viz-heading">
        <span className="viz-badge">
          <span /> 動畫圖解
        </span>
        <span className="viz-step-counter">
          {total ? currentStep + 1 : 0}
          <span> / {total}</span>
        </span>
      </header>
      <div className="viz-title-row">
        <Waypoints size={17} aria-hidden="true" />
        <h3><MathText text={visual.title} /></h3>
      </div>

      <div className={`viz-stage viz-kind-${visual.kind}`}>
        <div className="viz-stage-grid" aria-hidden="true" />
        <svg
          className="viz-svg"
          viewBox={`0 0 384 ${counterClosure ? 300 : 280}`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
        >
          <title
            id={`${id}-title`}
          >{`${visual.title}：${current?.title || "概念圖"}`}</title>
          <desc id={`${id}-description`}>
            {masked ? "本步變化已隱藏，先預測再揭曉" : current?.description || visual.caption}
          </desc>
          <defs>
            <marker
              id={`${id}-arrow`}
              markerWidth="5"
              markerHeight="5"
              refX="4"
              refY="2.5"
              orient="auto"
            >
              <path d="M0 0 L5 2.5 L0 5" fill="var(--text-3)" />
            </marker>
            <marker
              id={`${id}-arrow-active`}
              markerWidth="5"
              markerHeight="5"
              refX="4"
              refY="2.5"
              orient="auto"
            >
              <path d="M0 0 L5 2.5 L0 5" fill="var(--explain-text)" />
            </marker>
            <linearGradient id={`${id}-scope`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--raised)" />
              <stop offset="100%" stopColor="var(--panel)" />
            </linearGradient>
          </defs>

          {counterClosure && (
            <g aria-hidden="true">
              <rect
                className="viz-scope-outer"
                x="29"
                y="93"
                width="156"
                height="154"
                rx="16"
                fill={`url(#${id}-scope)`}
              />
              <rect
                className="viz-scope-inner"
                x="188"
                y="130"
                width="184"
                height="79"
                rx="14"
              />
              <text
                className="viz-scope-footer"
                x="29"
                y="279"
                textAnchor="start"
              >
                同一個 count 持續累加
              </text>
              <text
                className="viz-scope-footer"
                x="279"
                y="240"
                textAnchor="middle"
              >
                獨立的 count
              </text>
            </g>
          )}

          {visual.kind === "closure" && !counterClosure && (
            <g aria-hidden="true">
              <rect
                className="viz-scope-outer"
                x="24"
                y="29"
                width="336"
                height="227"
                rx="20"
                fill={`url(#${id}-scope)`}
              />
              <circle className="viz-scope-light" cx="342" cy="47" r="3" />
              <rect
                className="viz-scope-inner"
                x="37"
                y="122"
                width="310"
                height={nodes.length > 4 ? 119 : 73}
                rx="14"
              />
              <path
                className="viz-scope-thread"
                d="M 30 266 Q 192 283 354 266"
              />
              <text
                className="viz-scope-footer"
                x="192"
                y="274"
                textAnchor="middle"
              >
                保留環境的參照
              </text>
            </g>
          )}

          {visual.kind === "event-loop" && (
            <g aria-hidden="true">
              <circle className="viz-orbit-ring" cx="192" cy="130" r="87" />
              <circle
                className="viz-orbit-ring viz-orbit-ring-inner"
                cx="192"
                cy="130"
                r="67"
              />
              <g
                className="viz-orbit-arrow"
                style={{ transformOrigin: "192px 130px" }}
              >
                <circle cx="192" cy="43" r="5" fill="#375be9" />
                <circle cx="192" cy="43" r="10" fill="#375be9" opacity=".08" />
              </g>
              <text
                className="viz-scope-footer"
                x="192"
                y="268"
                textAnchor="middle"
              >
                一次處理一件事
              </text>
            </g>
          )}

          {visual.kind === "debounce" && (
            <g aria-hidden="true">
              <line
                className="viz-timeline-rail"
                x1="45"
                x2="339"
                y1="65"
                y2="65"
              />
              <line
                className="viz-timeline-progress"
                x1="45"
                x2={45 + 294 * progress}
                y1="65"
                y2="65"
              />
              {Array.from({ length: Math.max(total, 2) }, (_, index) => {
                const x = 45 + (index * 294) / Math.max(total - 1, 1);
                return (
                  <g key={index}>
                    <line
                      className={`viz-tick ${index <= currentStep ? "viz-tick-past" : ""}`}
                      x1={x}
                      x2={x}
                      y1="54"
                      y2="71"
                    />
                    {index === currentStep && (
                      <circle
                        className="viz-timer-pulse"
                        cx={x}
                        cy="65"
                        r="11"
                      />
                    )}
                  </g>
                );
              })}
              <circle
                className="viz-timeline-head"
                cx={45 + 294 * progress}
                cy="65"
                r="4.5"
              />
            </g>
          )}

          <g className="viz-links" aria-hidden="true">
            {links.map((link) => (
              <g key={link.key}>
                <path
                  className={`viz-link ${link.active ? "viz-link-active" : ""}`}
                  d={link.path}
                  markerEnd={
                    directed
                      ? `url(#${id}-${link.active ? "arrow-active" : "arrow"})`
                      : undefined
                  }
                />
                {link.active && playing && !reducedMotion && (
                  <circle className="viz-particle" r="3.2">
                    <animateMotion
                      dur={`${1.6 / speed}s`}
                      repeatCount="indefinite"
                      path={link.path}
                    />
                  </circle>
                )}
              </g>
            ))}
          </g>
          {nodes.map((node, index) => (
            <DiagramNode
              key={node.id}
              node={node}
              position={layout[index]}
              active={active.has(node.id)}
              width={nodeWidths[index]}
              height={nodeHeight}
            />
          ))}
        </svg>
      </div>

      {current?.output && (
        <div className="viz-output">
          <Terminal size={13} aria-hidden="true" />
          <code key={current.output}>{masked ? "？ 先預測，再揭曉" : current.output}</code>
        </div>
      )}

      <div className="viz-transport">
        <div className="viz-playback-controls">
          <button
            className="viz-icon-button"
            type="button"
            onClick={() => seek(0)}
            disabled={!total}
            aria-label="從頭開始"
            title="從頭開始"
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button
            className="viz-play-button"
            type="button"
            onClick={togglePlayback}
            disabled={total < 2}
            aria-label={
              reducedMotion
                ? currentStep >= total - 1
                  ? "回到第一步"
                  : "前進一個步驟"
                : playing
                  ? "暫停動畫"
                  : "播放動畫"
            }
            title={
              reducedMotion
                ? "減少動態效果已開啟，按一下前進一步"
                : playing
                  ? "暫停"
                  : "播放"
            }
          >
            {reducedMotion ? (
              <ArrowRight size={14} aria-hidden="true" />
            ) : playing ? (
              <Pause size={14} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play size={14} fill="currentColor" aria-hidden="true" />
            )}
          </button>
          <button
            className="viz-speed"
            type="button"
            onClick={() => setSpeed((value) => (value === 1 ? 1.5 : 1))}
            disabled={reducedMotion}
            aria-label={`播放速度 ${speed} 倍，點擊切換`}
            title={reducedMotion ? "逐步模式不使用播放速度" : "切換播放速度"}
          >
            {speed}×
          </button>
        </div>
        <div className="viz-step-dots" aria-label="動畫步驟">
          {visual.steps.map((item, index) => (
            <button
              key={index}
              type="button"
              className={`viz-step-dot ${index === currentStep ? "viz-step-dot-current" : ""} ${index < currentStep ? "viz-step-dot-past" : ""}`}
              aria-label={`第 ${index + 1} 步：${item.title}`}
              title={item.title}
              aria-current={index === currentStep ? "step" : undefined}
              onClick={() => seek(index)}
            />
          ))}
        </div>
        <div className="viz-step-controls">
          <button
            className="viz-icon-button"
            type="button"
            disabled={!total || currentStep === 0}
            onClick={() => seek(currentStep - 1)}
            aria-label="上一步"
            title="上一步"
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
          <button
            className="viz-icon-button"
            type="button"
            disabled={!total || currentStep >= total - 1}
            onClick={() => seek(currentStep + 1)}
            aria-label="下一步"
            title="下一步"
          >
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="viz-narrative" aria-live="polite" aria-atomic="true">
        <span className="viz-narrative-index">
          {total ? currentStep + 1 : 0}
        </span>
        <div>
          <h4><MathText text={current?.title || "概念總覽"} /></h4>
          {masked ? (
            <div className="sa-predict">
              <p>先預測：這一步會發生什麼{current?.output ? "、會輸出什麼" : ""}？</p>
              <button type="button" className="sa-reveal" onClick={reveal}>揭曉這一步</button>
            </div>
          ) : (
            <ProseBlocks text={current?.description || visual.caption} />
          )}
        </div>
      </div>
      {reducedMotion && <p className="viz-caption">已依系統偏好關閉自動播放，可使用箭頭逐步探索。</p>}
    </section>
  );
}

export default function ConceptAnimation(props: Props) {
  return props.visual.scene ? <SceneAnimation visual={props.visual} step={props.step} onStepChange={props.onStepChange} compact={props.compact} predict={props.predict}/> : <LegacyAnimation {...props}/>;
}
