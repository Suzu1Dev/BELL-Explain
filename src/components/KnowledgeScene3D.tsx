import { useEffect, useRef } from "react";
import sceneSpec from "./knowledge-scene.json";
import { stepSimulation, type SimEdge, type SimNode } from "./KnowledgeGraph";

interface KnowledgeScene3DProps {
  nodes: SimNode[];
  edges: SimEdge[];
  selectedId: string | null;
  autoOrbit: boolean;
  inspectorOpen: boolean;
  zoomRequest: { factor: number; seq: number };
  resetRequest: number;
  reheatRequest: number;
  onSelectNode: (id: string | null) => void;
  onOpenNode: (node: SimNode) => void;
}

type Rgb = readonly [number, number, number];

interface ParsedPalette {
  canvasHex: string;
  canvas: Rgb;
  globeRim: string;
  guideFront: string;
  guideBack: string;
  edgeLink: Rgb;
  edgeTopic: Rgb;
  edgeActive: Rgb;
  leaderLine: Rgb;
  topicFill: Rgb;
  specHighlight: Rgb;
  labelNote: Rgb;
  labelTopic: Rgb;
  labelHalo: string;
  tones: Rgb[];
}

function parseHex(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}

function mixCss(fg: Rgb, bg: Rgb, fog: number): string {
  const t = fog <= 0 ? 0 : fog >= 1 ? 1 : fog;
  const r = (fg[0] + (bg[0] - fg[0]) * t + 0.5) | 0;
  const g = (fg[1] + (bg[1] - fg[1]) * t + 0.5) | 0;
  const b = (fg[2] + (bg[2] - fg[2]) * t + 0.5) | 0;
  return `rgb(${r},${g},${b})`;
}

function buildPalette(raw: typeof sceneSpec.palettes.dark): ParsedPalette {
  return {
    canvasHex: raw.canvas,
    canvas: parseHex(raw.canvas),
    globeRim: raw.globeRim,
    guideFront: raw.guideFront,
    guideBack: raw.guideBack,
    edgeLink: parseHex(raw.edgeLink),
    edgeTopic: parseHex(raw.edgeTopic),
    edgeActive: parseHex(raw.edgeActive),
    leaderLine: parseHex(raw.leaderLine),
    topicFill: parseHex(raw.topicFill),
    specHighlight: parseHex(raw.specHighlight),
    labelNote: parseHex(raw.labelNote),
    labelTopic: parseHex(raw.labelTopic),
    labelHalo: raw.labelHalo,
    tones: raw.tones.map(parseHex),
  };
}

const PALETTES: Record<"dark" | "light", ParsedPalette> = {
  dark: buildPalette(sceneSpec.palettes.dark),
  light: buildPalette(sceneSpec.palettes.light),
};

const RING_SEGMENTS = 64;
const UNIT_CIRCLE: Array<readonly [number, number]> = Array.from({ length: RING_SEGMENTS + 1 }, (_, i) => {
  const a = (i / RING_SEGMENTS) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)] as const;
});

function currentThemeKey(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

interface FocusNeighborhood {
  primaryNodes: Set<string>;
  secondaryNodes: Set<string>;
  primaryEdges: Set<string>;
  secondaryEdges: Set<string>;
}

function buildFocusMap(nodes: SimNode[], edges: SimEdge[]): Map<string, FocusNeighborhood> {
  const map = new Map<string, FocusNeighborhood>();
  for (const node of nodes) {
    const primaryNodes = new Set<string>([node.id]);
    const secondaryNodes = new Set<string>();
    const primaryEdges = new Set<string>();
    const secondaryEdges = new Set<string>();
    const sharedTopics: string[] = [];

    for (const edge of edges) {
      if (edge.from === node.id || edge.to === node.id) {
        const other = edge.from === node.id ? edge.to : edge.from;
        primaryNodes.add(other);
        primaryEdges.add(edge.key);
        if (edge.kind === "topic") sharedTopics.push(other);
      }
    }

    for (const topicId of sharedTopics) {
      for (const edge of edges) {
        if (edge.to === topicId && edge.from !== node.id) {
          if (!primaryNodes.has(edge.from)) secondaryNodes.add(edge.from);
          if (!primaryEdges.has(edge.key)) secondaryEdges.add(edge.key);
        }
      }
    }

    map.set(node.id, { primaryNodes, secondaryNodes, primaryEdges, secondaryEdges });
  }
  return map;
}

interface ProjectedNode {
  sx: number;
  sy: number;
  zCam: number;
  persp: number;
  r: number;
  labelW: number;
  fullLabelW: number;
  lastSlot: number;
  hasLabel: boolean;
  lx1: number;
  ly1: number;
  lx2: number;
  ly2: number;
}

interface LabelCandidate {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  drawX: number;
  drawY: number;
  align: CanvasTextAlign;
  leader: boolean;
  anchorX: number;
  anchorY: number;
}

export function buildLabelSlots(
  sx: number,
  sy: number,
  r: number,
  w: number,
  h: number,
): LabelCandidate[] {
  const pad = r + 7;
  const sideGap = r + 9;
  const diagX = r + 14;
  const diagY = r + 10;
  return [
    // 0: Bottom center
    { x1: sx - w * 0.5, y1: sy + pad, x2: sx + w * 0.5, y2: sy + pad + h, drawX: sx, drawY: sy + pad, align: "center", leader: false, anchorX: sx, anchorY: sy + pad },
    // 1: Top center
    { x1: sx - w * 0.5, y1: sy - pad - h, x2: sx + w * 0.5, y2: sy - pad, drawX: sx, drawY: sy - pad - h, align: "center", leader: false, anchorX: sx, anchorY: sy - pad },
    // 2: Right middle
    { x1: sx + sideGap, y1: sy - h * 0.5, x2: sx + sideGap + w, y2: sy + h * 0.5, drawX: sx + sideGap + 2, drawY: sy - h * 0.5, align: "left", leader: false, anchorX: sx + sideGap, anchorY: sy },
    // 3: Left middle
    { x1: sx - sideGap - w, y1: sy - h * 0.5, x2: sx - sideGap, y2: sy + h * 0.5, drawX: sx - sideGap - 2, drawY: sy - h * 0.5, align: "right", leader: false, anchorX: sx - sideGap, anchorY: sy },
    // 4: Bottom-right callout with leader tick
    { x1: sx + diagX, y1: sy + diagY, x2: sx + diagX + w, y2: sy + diagY + h, drawX: sx + diagX + 3, drawY: sy + diagY, align: "left", leader: true, anchorX: sx + diagX, anchorY: sy + diagY + h * 0.45 },
    // 5: Top-right callout with leader tick
    { x1: sx + diagX, y1: sy - diagY - h, x2: sx + diagX + w, y2: sy - diagY, drawX: sx + diagX + 3, drawY: sy - diagY - h, align: "left", leader: true, anchorX: sx + diagX, anchorY: sy - diagY - h * 0.45 },
    // 6: Bottom-left callout with leader tick
    { x1: sx - diagX - w, y1: sy + diagY, x2: sx - diagX, y2: sy + diagY + h, drawX: sx - diagX - 3, drawY: sy + diagY, align: "right", leader: true, anchorX: sx - diagX, anchorY: sy + diagY + h * 0.45 },
    // 7: Top-left callout with leader tick
    { x1: sx - diagX - w, y1: sy - diagY - h, x2: sx - diagX, y2: sy - diagY, drawX: sx - diagX - 3, drawY: sy - diagY - h, align: "right", leader: true, anchorX: sx - diagX, anchorY: sy - diagY - h * 0.45 },
  ];
}

export function pickLabelSlot(
  slots: LabelCandidate[],
  placedBoxes: ReadonlyArray<readonly [number, number, number, number]>,
  rightBound: number,
  bottomBound: number,
  lastSlot: number,
  allowFallback: boolean,
): number {
  const overlapArea = (x1: number, y1: number, x2: number, y2: number, margin: number): number => {
    let area = 0;
    if (x1 < 12) area += (12 - x1) * 40;
    if (x2 > rightBound) area += (x2 - rightBound) * 40;
    if (y1 < 12) area += (12 - y1) * 40;
    if (y2 > bottomBound) area += (y2 - bottomBound) * 40;
    for (let i = 0; i < placedBoxes.length; i++) {
      const b = placedBoxes[i];
      const ox = Math.min(x2 + margin, b[2]) - Math.max(x1 - margin, b[0]);
      const oy = Math.min(y2 + margin, b[3]) - Math.max(y1 - margin, b[1]);
      if (ox > 0 && oy > 0) area += ox * oy;
    }
    return area;
  };

  if (overlapArea(slots[0].x1, slots[0].y1, slots[0].x2, slots[0].y2, 2) === 0) return 0;
  if (
    lastSlot > 0 &&
    lastSlot < slots.length &&
    overlapArea(slots[lastSlot].x1, slots[lastSlot].y1, slots[lastSlot].x2, slots[lastSlot].y2, 0) === 0
  ) {
    return lastSlot;
  }
  for (let s = 0; s < slots.length; s++) {
    if (overlapArea(slots[s].x1, slots[s].y1, slots[s].x2, slots[s].y2, 1.5) === 0) return s;
  }
  if (!allowFallback) return -1;

  let bestArea = Infinity;
  let bestIdx = 0;
  for (let s = 0; s < slots.length; s++) {
    const a = overlapArea(slots[s].x1, slots[s].y1, slots[s].x2, slots[s].y2, 0);
    if (a < bestArea) {
      bestArea = a;
      bestIdx = s;
    }
  }
  return bestIdx;
}

export default function KnowledgeScene3D({
  nodes,
  edges,
  selectedId,
  autoOrbit,
  inspectorOpen,
  zoomRequest,
  resetRequest,
  reheatRequest,
  onSelectNode,
  onOpenNode,
}: KnowledgeScene3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const callbacksRef = useRef({ onSelectNode, onOpenNode });
  callbacksRef.current = { onSelectNode, onOpenNode };

  const runtimeRef = useRef<{
    simNodes: SimNode[];
    simEdges: SimEdge[];
    nodeIndexById: Map<string, number>;
    focusMap: Map<string, FocusNeighborhood>;
    projected: ProjectedNode[];
    nodeOrder: number[];
    labelPriorityOrder: number[];
    edgeFromIdx: number[];
    edgeToIdx: number[];
    edgeOrder: number[];
    selectedId: string | null;
    hoveredId: string | null;
    pinnedId: string | null;
    autoOrbit: boolean;
    inspectorOpen: boolean;
    yaw: number;
    pitch: number;
    targetYaw: number | null;
    targetPitch: number | null;
    velYaw: number;
    velPitch: number;
    zoom: number;
    targetZoom: number;
    offsetX: number;
    focusMix: number;
    alpha: number;
    measureLabels: () => void;
    focusNodeToFront: (id: string) => void;
    requestTick: () => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let cssW = Math.max(320, canvas.clientWidth || 960);
    let cssH = Math.max(320, canvas.clientHeight || 580);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const syncCanvasSize = (w: number, h: number) => {
      cssW = Math.max(320, w);
      cssH = Math.max(320, h);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    syncCanvasSize(cssW, cssH);

    const fontSans =
      getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() ||
      "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

    const state = {
      simNodes: [] as SimNode[],
      simEdges: [] as SimEdge[],
      nodeIndexById: new Map<string, number>(),
      focusMap: new Map<string, FocusNeighborhood>(),
      projected: [] as ProjectedNode[],
      nodeOrder: [] as number[],
      labelPriorityOrder: [] as number[],
      edgeFromIdx: [] as number[],
      edgeToIdx: [] as number[],
      edgeOrder: [] as number[],
      selectedId,
      hoveredId: null as string | null,
      pinnedId: null as string | null,
      autoOrbit,
      inspectorOpen,
      yaw: sceneSpec.camera.initialYaw,
      pitch: sceneSpec.camera.initialPitch,
      targetYaw: null as number | null,
      targetPitch: null as number | null,
      velYaw: prefersReducedMotion ? 0 : sceneSpec.camera.entranceVelYaw,
      velPitch: 0,
      zoom: 1,
      targetZoom: 1,
      offsetX: 0,
      focusMix: 0,
      alpha: 0,
      measureLabels: () => {},
      focusNodeToFront: (_id: string) => {},
      requestTick: () => {},
    };

    const measureLabels = () => {
      ctx.save();
      for (let i = 0; i < state.simNodes.length; i++) {
        const n = state.simNodes[i];
        ctx.font = n.kind === "topic" ? `500 11px ${fontSans}` : `500 12px ${fontSans}`;
        const shortText = n.kind === "topic" ? `#${n.shortLabel}` : n.shortLabel;
        state.projected[i].labelW = ctx.measureText(shortText).width;
        ctx.font = n.kind === "topic" ? `600 11.5px ${fontSans}` : `600 13px ${fontSans}`;
        const fullText =
          n.kind === "note" && n.label.length <= 24
            ? n.label
            : shortText;
        state.projected[i].fullLabelW = ctx.measureText(fullText).width;
      }
      ctx.restore();
    };
    state.measureLabels = measureLabels;

    const focusNodeToFront = (id: string) => {
      const idx = state.nodeIndexById.get(id);
      if (idx === undefined) return;
      const node = state.simNodes[idx];
      const desiredYaw = Math.atan2(-node.x, node.z);
      const rawDiff = ((desiredYaw - state.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      state.targetYaw = state.yaw + rawDiff;
      state.targetPitch = Math.max(
        -1.02,
        Math.min(1.02, Math.atan2(node.y, Math.max(1, Math.hypot(node.x, node.z)))),
      );
      state.velYaw = 0;
      state.velPitch = 0;
    };
    state.focusNodeToFront = focusNodeToFront;

    const fov = sceneSpec.camera.fov;
    const sphereR = sceneSpec.sphere.guideRadius;

    const projectPoint = (
      wx: number,
      wy: number,
      wz: number,
      cy: number,
      sy: number,
      cp: number,
      sp: number,
      cx: number,
      centerY: number,
      zoom: number,
    ) => {
      const x1 = wx * cy + wz * sy;
      const z1 = -wx * sy + wz * cy;
      const y2 = wy * cp - z1 * sp;
      const zCam = wy * sp + z1 * cp;
      const persp = (fov / Math.max(190, fov - zCam)) * zoom;
      return {
        sx: cx + x1 * persp,
        sy: centerY - y2 * persp,
        zCam,
        persp,
      };
    };

    const drawGreatCircle = (
      axis: 0 | 1 | 2,
      cy: number,
      sy: number,
      cp: number,
      sp: number,
      cx: number,
      centerY: number,
      zoom: number,
      pal: ParsedPalette,
    ) => {
      let prevSx = 0;
      let prevSy = 0;
      let prevFront = false;
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const [u, v] = UNIT_CIRCLE[i];
        const wx = axis === 0 ? u * sphereR : axis === 1 ? u * sphereR : 0;
        const wy = axis === 0 ? 0 : axis === 1 ? v * sphereR : u * sphereR;
        const wz = axis === 0 ? v * sphereR : axis === 1 ? 0 : v * sphereR;
        const p = projectPoint(wx, wy, wz, cy, sy, cp, sp, cx, centerY, zoom);
        const front = p.zCam >= 0;
        if (i > 0) {
          ctx.beginPath();
          ctx.moveTo(prevSx, prevSy);
          ctx.lineTo(p.sx, p.sy);
          ctx.strokeStyle = front && prevFront ? pal.guideFront : pal.guideBack;
          ctx.lineWidth = front && prevFront ? 0.85 : 0.65;
          ctx.stroke();
        }
        prevSx = p.sx;
        prevSy = p.sy;
        prevFront = front;
      }
    };

    let rafId: number | null = null;
    let isDraggingCanvas = false;

    const renderFrame = () => {
      const pal = PALETTES[currentThemeKey()];
      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = pal.canvasHex;
      ctx.fillRect(0, 0, cssW, cssH);

      const cx = cssW * 0.5 - state.offsetX;
      const centerY = cssH * 0.485;
      const cy = Math.cos(state.yaw);
      const sy = Math.sin(state.yaw);
      const cp = Math.cos(state.pitch);
      const sp = Math.sin(state.pitch);
      const zoom = state.zoom;

      // Subtle outer 3D globe limb + 3 orthogonal orbital rings (100% solid hairline strokes, zero gradients)
      ctx.beginPath();
      ctx.arc(cx, centerY, sphereR * zoom * 1.015, 0, Math.PI * 2);
      ctx.strokeStyle = pal.globeRim;
      ctx.lineWidth = 0.9;
      ctx.stroke();

      drawGreatCircle(0, cy, sy, cp, sp, cx, centerY, zoom, pal);
      drawGreatCircle(1, cy, sy, cp, sp, cx, centerY, zoom, pal);
      drawGreatCircle(2, cy, sy, cp, sp, cx, centerY, zoom, pal);

      const nCount = state.simNodes.length;
      if (nCount === 0) {
        ctx.restore();
        return;
      }

      const activeId = state.hoveredId ?? state.selectedId;
      const focus = activeId ? state.focusMap.get(activeId) : undefined;
      const fm = state.focusMix;

      // 1. Project all 3D nodes into camera/screen space
      for (let i = 0; i < nCount; i++) {
        const n = state.simNodes[i];
        const p = projectPoint(n.x, n.y, n.z, cy, sy, cp, sp, cx, centerY, zoom);
        const proj = state.projected[i];
        proj.sx = p.sx;
        proj.sy = p.sy;
        proj.zCam = p.zCam;
        proj.persp = p.persp;
        proj.hasLabel = false;

        const baseR =
          n.kind === "topic"
            ? sceneSpec.nodes.topicRadius
            : Math.min(
                sceneSpec.nodes.noteMaxRadius,
                sceneSpec.nodes.noteBaseRadius + n.degree * sceneSpec.nodes.noteDegreeScale,
              );
        const isHero = n.id === activeId || n.id === state.selectedId;
        const isPri = focus?.primaryNodes.has(n.id) ?? false;
        const boost = isHero ? 1 + 0.28 * fm : isPri && activeId ? 1 + 0.1 * fm : 1;
        proj.r = Math.max(2.0, baseR * p.persp * boost);
      }

      // 2. Smooth C0 screen-space tangent separation so near-depth spheres never eclipse dead-on
      const minGap = sceneSpec.sphere.screenMinDotGap * Math.min(1.15, Math.max(0.8, zoom));
      const depthBand = sphereR * 0.85;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < nCount; i++) {
          const pa = state.projected[i];
          const aFront = pa.zCam > -sphereR * 0.25 || (focus?.primaryNodes.has(state.simNodes[i].id) ?? false);
          if (!aFront) continue;
          for (let j = i + 1; j < nCount; j++) {
            const pb = state.projected[j];
            const bFront = pb.zCam > -sphereR * 0.25 || (focus?.primaryNodes.has(state.simNodes[j].id) ?? false);
            if (!bFront) continue;
            const dz = Math.abs(pa.zCam - pb.zCam);
            if (dz >= depthBand) continue;
            const zWeight = 1 - dz / depthBand;
            const dx = pb.sx - pa.sx || (i % 2 ? 0.4 : -0.4);
            const dy = pb.sy - pa.sy || (j % 2 ? 0.4 : -0.4);
            const d = Math.hypot(dx, dy) || 0.1;
            const req = minGap + (pa.r + pb.r) * 0.35;
            if (d < req) {
              const push = (req - d) * 0.42 * zWeight;
              const ux = (dx / d) * push;
              const uy = (dy / d) * push;
              pa.sx -= ux;
              pa.sy -= uy;
              pb.sx += ux;
              pb.sy += uy;
            }
          }
        }
      }

      // 3. Depth-sort edges back-to-front
      state.edgeOrder.sort((a, b) => {
        const za = state.projected[state.edgeFromIdx[a]].zCam + state.projected[state.edgeToIdx[a]].zCam;
        const zb = state.projected[state.edgeFromIdx[b]].zCam + state.projected[state.edgeToIdx[b]].zCam;
        return za - zb;
      });

      ctx.lineCap = "round";
      for (let k = 0; k < state.edgeOrder.length; k++) {
        const ei = state.edgeOrder[k];
        const fi = state.edgeFromIdx[ei];
        const ti = state.edgeToIdx[ei];
        if (fi < 0 || ti < 0) continue;
        const edge = state.simEdges[ei];
        const pa = state.projected[fi];
        const pb = state.projected[ti];
        const avgZ = (pa.zCam + pb.zCam) * 0.5;
        const depthNorm = Math.max(0, Math.min(1, (avgZ + sphereR) / (2 * sphereR)));
        const baseFog = 0.76 - depthNorm * 0.56;

        const isSemantic = edge.kind === "link" || edge.kind === "follow";
        const isPri = focus?.primaryEdges.has(edge.key) ?? false;
        const isSec = !isPri && (focus?.secondaryEdges.has(edge.key) ?? false);

        let rgb = isSemantic ? pal.edgeLink : pal.edgeTopic;
        let fog = isSemantic ? baseFog : Math.min(0.9, baseFog + 0.18);
        let width = isSemantic ? 1.15 : 0.8;

        if (focus && fm > 0.01) {
          if (isPri) {
            rgb = pal.edgeActive;
            fog = fog * (1 - fm) + 0.04 * fm;
            width = width + (1.75 - width) * fm;
          } else if (isSec) {
            fog = fog * (1 - fm) + 0.54 * fm;
          } else {
            fog = fog * (1 - fm) + 0.91 * fm;
          }
        }

        ctx.beginPath();
        ctx.moveTo(pa.sx, pa.sy);
        ctx.lineTo(pb.sx, pb.sy);
        ctx.strokeStyle = mixCss(rgb, pal.canvas, fog);
        ctx.lineWidth = width;
        ctx.stroke();

        if (isSemantic && (!focus || isPri || fm < 0.35) && fog < 0.72) {
          const dx = pb.sx - pa.sx;
          const dy = pb.sy - pa.sy;
          const segLen = Math.hypot(dx, dy);
          if (segLen > 28) {
            const ux = dx / segLen;
            const uy = dy / segLen;
            const mx = pa.sx + dx * 0.62;
            const my = pa.sy + dy * 0.62;
            const sz = isPri && focus ? 4.4 : 3.2;
            ctx.beginPath();
            ctx.moveTo(mx - ux * sz - uy * sz * 0.62, my - uy * sz + ux * sz * 0.62);
            ctx.lineTo(mx, my);
            ctx.lineTo(mx - ux * sz + uy * sz * 0.62, my - uy * sz - ux * sz * 0.62);
            ctx.stroke();
          }
        }
      }

      // 4. Depth-sort micro-spheres back-to-front (Painter's algorithm)
      state.nodeOrder.sort((a, b) => state.projected[a].zCam - state.projected[b].zCam);

      for (let k = 0; k < nCount; k++) {
        const ni = state.nodeOrder[k];
        const node = state.simNodes[ni];
        const proj = state.projected[ni];
        const depthNorm = Math.max(0, Math.min(1, (proj.zCam + sphereR) / (2 * sphereR)));
        const baseFog = 0.72 - depthNorm * 0.72;

        const isHero = node.id === activeId || node.id === state.selectedId;
        const isPri = focus?.primaryNodes.has(node.id) ?? false;
        const isSec = !isPri && (focus?.secondaryNodes.has(node.id) ?? false);

        let nodeFog = baseFog;
        if (focus && fm > 0.01) {
          if (isHero || isPri) nodeFog = nodeFog * (1 - fm);
          else if (isSec) nodeFog = nodeFog * (1 - fm) + 0.45 * fm;
          else nodeFog = nodeFog * (1 - fm) + 0.85 * fm;
        }

        const baseRgb = node.kind === "topic" ? pal.topicFill : pal.tones[node.tone % pal.tones.length];

        if (isHero) {
          ctx.beginPath();
          ctx.arc(proj.sx, proj.sy, proj.r + 4.6, 0, Math.PI * 2);
          ctx.strokeStyle = mixCss(pal.edgeActive, pal.canvas, 0.05);
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else if (focus && isPri && fm > 0.15) {
          ctx.beginPath();
          ctx.arc(proj.sx, proj.sy, proj.r + 3.2, 0, Math.PI * 2);
          ctx.strokeStyle = mixCss(baseRgb, pal.canvas, 0.35 + (1 - fm) * 0.4);
          ctx.lineWidth = 1.05;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(proj.sx, proj.sy, proj.r, 0, Math.PI * 2);
        ctx.fillStyle = mixCss(baseRgb, pal.canvas, nodeFog);
        ctx.fill();

        // Subtle solid 3D pinpoint highlight on note micro-spheres (zero gradients, crisp ceramic bead feel)
        if (node.kind === "note" && nodeFog < 0.62 && proj.r >= 4.2) {
          ctx.beginPath();
          ctx.arc(
            proj.sx - proj.r * 0.3,
            proj.sy - proj.r * 0.3,
            Math.max(0.95, proj.r * 0.24),
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = mixCss(pal.specHighlight, baseRgb, 0.28 + nodeFog * 0.65);
          ctx.fill();
        }
      }

      // 5. 8-Slot Cartographic Label Solver with Front-Hemisphere Horizon Fade & Hairline Callout Leaders
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";

      const horizonZ = sphereR * sceneSpec.sphere.horizonLabelCutoff;
      const rightBound = state.inspectorOpen && cssW >= 880 ? cssW - 354 : cssW - 12;
      const bottomBound = cssH - 58;

      const placedBoxes: Array<readonly [number, number, number, number]> = [];
      // Reserve visible front-hemisphere & active micro-spheres so labels never cross over dots
      for (let i = 0; i < nCount; i++) {
        const proj = state.projected[i];
        const node = state.simNodes[i];
        const isPri = focus?.primaryNodes.has(node.id) ?? false;
        if (proj.zCam >= horizonZ || isPri) {
          const pad = node.kind === "note" ? proj.r + 3.5 : proj.r + 2;
          placedBoxes.push([proj.sx - pad, proj.sy - pad, proj.sx + pad, proj.sy + pad]);
        }
      }

      // Sort label candidates: Hero -> Primary Notes -> Primary Topics -> Front Notes -> Front Topics
      const rankOf = (idx: number): number => {
        const node = state.simNodes[idx];
        const z = state.projected[idx].zCam;
        if (node.id === activeId || node.id === state.selectedId) return 100000 + z;
        const isPri = focus?.primaryNodes.has(node.id) ?? false;
        if (isPri && node.kind === "note") return 80000 + z;
        if (isPri) return 60000 + z;
        if (node.kind === "note") return 30000 + z;
        return 10000 + z;
      };
      state.labelPriorityOrder.sort((a, b) => rankOf(b) - rankOf(a));

      for (let k = 0; k < nCount; k++) {
        const ni = state.labelPriorityOrder[k];
        const node = state.simNodes[ni];
        const proj = state.projected[ni];
        const isHero = node.id === activeId || node.id === state.selectedId;
        const isPri = focus?.primaryNodes.has(node.id) ?? false;
        const isSec = !isPri && (focus?.secondaryNodes.has(node.id) ?? false);

        // Back-hemisphere horizon gate: hide back-of-globe labels unless actively focused!
        const cutoff = node.kind === "topic" ? sphereR * 0.02 : horizonZ;
        if (!isHero && !isPri && proj.zCam < cutoff) continue;
        if (!isHero && !isPri && node.kind === "topic" && zoom < 0.88) continue;

        // Smooth horizon fade so labels emerge gracefully as spheres rotate into the front hemisphere
        const horizonBand = sphereR * 0.28;
        const horizonVis = isHero || isPri ? 1 : Math.max(0, Math.min(1, (proj.zCam - cutoff) / horizonBand));
        const depthNorm = Math.max(0, Math.min(1, (proj.zCam + sphereR) / (2 * sphereR)));
        let labelFog = 0.62 - depthNorm * 0.62;
        labelFog = 1 - (1 - labelFog) * horizonVis;

        if (focus && fm > 0.01) {
          if (isHero || isPri) labelFog = labelFog * (1 - fm);
          else if (isSec) labelFog = labelFog * (1 - fm) + 0.58 * fm;
          else labelFog = labelFog * (1 - fm) + 0.93 * fm;
        }
        if (labelFog >= 0.91) continue;

        const text =
          isHero && node.kind === "note" && node.label.length <= 24
            ? node.label
            : node.kind === "topic"
              ? `#${node.shortLabel}`
              : node.shortLabel;

        const textW = (isHero ? proj.fullLabelW : proj.labelW) + 6;
        const lineH = isHero ? 17 : node.kind === "topic" ? 14 : 16;
        const slots = buildLabelSlots(proj.sx, proj.sy, proj.r, textW, lineH);

        const chosenIdx = pickLabelSlot(
          slots,
          placedBoxes,
          rightBound,
          bottomBound,
          proj.lastSlot,
          isHero || (isPri && node.kind === "note"),
        );
        if (chosenIdx < 0) continue;

        const slot = slots[chosenIdx];
        proj.lastSlot = chosenIdx;
        proj.hasLabel = true;
        proj.lx1 = slot.x1;
        proj.ly1 = slot.y1;
        proj.lx2 = slot.x2;
        proj.ly2 = slot.y2;
        placedBoxes.push([slot.x1, slot.y1, slot.x2, slot.y2]);

        // Draw delicate hairline callout leader when displaced to diagonal slot
        if (slot.leader) {
          const dx = slot.anchorX - proj.sx;
          const dy = slot.anchorY - proj.sy;
          const len = Math.hypot(dx, dy) || 1;
          const startR = proj.r + 2.5;
          ctx.beginPath();
          ctx.moveTo(proj.sx + (dx / len) * startR, proj.sy + (dy / len) * startR);
          ctx.lineTo(slot.anchorX, slot.anchorY);
          ctx.strokeStyle = mixCss(isHero || isPri ? pal.edgeActive : pal.leaderLine, pal.canvas, labelFog * 0.85);
          ctx.lineWidth = 0.95;
          ctx.stroke();
        }

        ctx.textAlign = slot.align;
        ctx.font = isHero
          ? `600 ${node.kind === "topic" ? 11.5 : 13}px ${fontSans}`
          : node.kind === "topic"
            ? `500 11px ${fontSans}`
            : `500 12px ${fontSans}`;
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = pal.labelHalo;
        ctx.strokeText(text, slot.drawX, slot.drawY);
        const textRgb = node.kind === "topic" ? pal.labelTopic : pal.labelNote;
        ctx.fillStyle = mixCss(isHero ? pal.labelNote : textRgb, pal.canvas, labelFog);
        ctx.fillText(text, slot.drawX, slot.drawY);
      }

      ctx.restore();
    };

    const tick = () => {
      rafId = null;
      let keepAlive = false;

      // Smooth camera center shift when Inspector opens/closes
      const desiredOffset = state.inspectorOpen && cssW >= 880 ? 174 : 0;
      if (Math.abs(state.offsetX - desiredOffset) > 0.4) {
        state.offsetX += (desiredOffset - state.offsetX) * 0.18;
        keepAlive = true;
      } else {
        state.offsetX = desiredOffset;
      }

      // Smooth zoom interpolation
      if (Math.abs(state.zoom - state.targetZoom) > 0.0015) {
        state.zoom += (state.targetZoom - state.zoom) * 0.22;
        keepAlive = true;
      } else {
        state.zoom = state.targetZoom;
      }

      // Smooth focus spotlight transition
      const desiredFocus = state.hoveredId || state.selectedId ? 1 : 0;
      if (Math.abs(state.focusMix - desiredFocus) > 0.008) {
        state.focusMix += (desiredFocus - state.focusMix) * 0.24;
        keepAlive = true;
      } else {
        state.focusMix = desiredFocus;
      }

      // Click-to-Front spherical alignment OR inertial spin / optional ambient orbit
      if (!isDraggingCanvas && !state.pinnedId) {
        if (state.targetYaw !== null && state.targetPitch !== null) {
          const dyaw = state.targetYaw - state.yaw;
          const dpitch = state.targetPitch - state.pitch;
          if (Math.abs(dyaw) > 0.0015 || Math.abs(dpitch) > 0.0015) {
            state.yaw += dyaw * 0.16;
            state.pitch += dpitch * 0.16;
            keepAlive = true;
          } else {
            state.yaw = state.targetYaw;
            state.pitch = state.targetPitch;
            state.targetYaw = null;
            state.targetPitch = null;
          }
        } else if (Math.abs(state.velYaw) > 0.00012 || Math.abs(state.velPitch) > 0.00012) {
          state.yaw += state.velYaw;
          state.pitch = Math.max(-1.24, Math.min(1.24, state.pitch + state.velPitch));
          state.velYaw *= sceneSpec.camera.inertiaDecay;
          state.velPitch *= sceneSpec.camera.inertiaDecay;
          keepAlive = true;
        } else {
          state.velYaw = 0;
          state.velPitch = 0;
          if (state.autoOrbit && !prefersReducedMotion && !state.hoveredId && !state.selectedId) {
            state.yaw += sceneSpec.camera.autoOrbitSpeed;
            keepAlive = true;
          }
        }
      }

      // 3D spring-sphere physics relaxation
      if (state.alpha > 0.004 || state.pinnedId) {
        stepSimulation(
          state.simNodes,
          state.simEdges,
          Math.max(state.alpha, state.pinnedId ? 0.32 : 0),
          state.pinnedId,
        );
        if (!state.pinnedId) state.alpha *= 0.92;
        keepAlive = true;
      }

      renderFrame();

      if (keepAlive) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const requestTick = () => {
      if (rafId === null) rafId = window.requestAnimationFrame(tick);
    };
    state.requestTick = requestTick;
    runtimeRef.current = state;

    const hitTest = (localX: number, localY: number): number => {
      const hitPad = sceneSpec.nodes.hitRadius;
      for (let k = state.nodeOrder.length - 1; k >= 0; k--) {
        const ni = state.nodeOrder[k];
        const p = state.projected[ni];
        const rHit = Math.max(hitPad, p.r + 7);
        const dx = localX - p.sx;
        const dy = localY - p.sy;
        if (dx * dx + dy * dy <= rHit * rHit) return ni;
        if (
          p.hasLabel &&
          localX >= p.lx1 - 3 &&
          localX <= p.lx2 + 3 &&
          localY >= p.ly1 - 2 &&
          localY <= p.ly2 + 2
        ) {
          return ni;
        }
      }
      return -1;
    };

    let dragInfo: {
      pointerId: number;
      nodeIdx: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      moved: boolean;
    } | null = null;
    let lastClick = { id: "", at: 0 };

    const getLocalCoords = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const { x, y } = getLocalCoords(event);
      const hitIdx = hitTest(x, y);
      dragInfo = {
        pointerId: event.pointerId,
        nodeIdx: hitIdx,
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        moved: false,
      };
      state.velYaw = 0;
      state.velPitch = 0;
      if (hitIdx < 0) isDraggingCanvas = true;
      canvas.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const { x, y } = getLocalCoords(event);

      if (!dragInfo) {
        const hitIdx = hitTest(x, y);
        const nextHover = hitIdx >= 0 ? state.simNodes[hitIdx].id : null;
        if (nextHover !== state.hoveredId) {
          state.hoveredId = nextHover;
          canvas.style.cursor = nextHover ? "pointer" : "grab";
          requestTick();
        }
        return;
      }

      if (dragInfo.pointerId !== event.pointerId) return;
      const dx = x - dragInfo.lastX;
      const dy = y - dragInfo.lastY;
      dragInfo.lastX = x;
      dragInfo.lastY = y;

      if (!dragInfo.moved && Math.hypot(x - dragInfo.startX, y - dragInfo.startY) > 4) {
        dragInfo.moved = true;
        state.targetYaw = null;
        state.targetPitch = null;
        if (dragInfo.nodeIdx >= 0) {
          state.pinnedId = state.simNodes[dragInfo.nodeIdx].id;
          state.alpha = 0.38;
        }
        canvas.style.cursor = "grabbing";
      }

      if (!dragInfo.moved) return;

      if (dragInfo.nodeIdx >= 0) {
        const node = state.simNodes[dragInfo.nodeIdx];
        const proj = state.projected[dragInfo.nodeIdx];
        const invScale = 1 / Math.max(0.28, proj.persp);
        const cy = Math.cos(state.yaw);
        const sy = Math.sin(state.yaw);
        const cp = Math.cos(state.pitch);
        const sp = Math.sin(state.pitch);

        const ux = dx * invScale;
        const uy = -dy * invScale;

        node.x += ux * cy + uy * (-sy * sp);
        node.y += uy * cp;
        node.z += ux * -sy + uy * (-cy * sp);

        const curR = Math.hypot(node.x, node.y, node.z) || 1;
        const clampedR = Math.max(node.targetR * 0.65, Math.min(node.targetR * 1.32, curR));
        if (curR !== clampedR) {
          const s = clampedR / curR;
          node.x *= s;
          node.y *= s;
          node.z *= s;
        }
        node.vx = 0;
        node.vy = 0;
        node.vz = 0;
        state.alpha = Math.max(state.alpha, 0.34);
        requestTick();
      } else {
        const spinYaw = -dx * 0.0062;
        const spinPitch = dy * 0.0062;
        state.yaw += spinYaw;
        state.pitch = Math.max(-1.24, Math.min(1.24, state.pitch + spinPitch));
        state.velYaw = spinYaw * 0.85;
        state.velPitch = spinPitch * 0.85;
        requestTick();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!dragInfo || dragInfo.pointerId !== event.pointerId) return;
      const finished = dragInfo;
      dragInfo = null;
      isDraggingCanvas = false;
      state.pinnedId = null;

      const { x, y } = getLocalCoords(event);
      const hitIdx = hitTest(x, y);
      canvas.style.cursor = hitIdx >= 0 ? "pointer" : "grab";

      if (finished.moved) {
        if (finished.nodeIdx >= 0) state.alpha = 0.24;
        requestTick();
        return;
      }

      if (finished.nodeIdx >= 0) {
        const node = state.simNodes[finished.nodeIdx];
        const now = Date.now();
        if (lastClick.id === node.id && now - lastClick.at < 340) {
          lastClick = { id: "", at: 0 };
          callbacksRef.current.onOpenNode(node);
        } else {
          lastClick = { id: node.id, at: now };
          callbacksRef.current.onSelectNode(state.selectedId === node.id ? null : node.id);
        }
      } else {
        callbacksRef.current.onSelectNode(null);
      }
    };

    const onPointerLeave = () => {
      if (!dragInfo && state.hoveredId !== null) {
        state.hoveredId = null;
        canvas.style.cursor = "grab";
        requestTick();
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0014);
      state.targetZoom = Math.max(
        sceneSpec.camera.minZoom,
        Math.min(sceneSpec.camera.maxZoom, state.targetZoom * factor),
      );
      requestTick();
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 60 || rect.height < 60) return;
      syncCanvasSize(rect.width, rect.height);
      requestTick();
    });
    resizeObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => requestTick());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.simNodes = nodes.map(n => ({ ...n }));
    rt.simEdges = edges;
    rt.nodeIndexById = new Map(rt.simNodes.map((n, i) => [n.id, i]));
    rt.focusMap = buildFocusMap(rt.simNodes, edges);
    rt.projected = rt.simNodes.map(() => ({
      sx: 0,
      sy: 0,
      zCam: 0,
      persp: 1,
      r: 5,
      labelW: 48,
      fullLabelW: 56,
      lastSlot: 0,
      hasLabel: false,
      lx1: 0,
      ly1: 0,
      lx2: 0,
      ly2: 0,
    }));
    rt.nodeOrder = rt.simNodes.map((_, i) => i);
    rt.labelPriorityOrder = rt.simNodes.map((_, i) => i);
    rt.edgeFromIdx = edges.map(e => rt.nodeIndexById.get(e.from) ?? -1);
    rt.edgeToIdx = edges.map(e => rt.nodeIndexById.get(e.to) ?? -1);
    rt.edgeOrder = edges.map((_, i) => i);
    rt.pinnedId = null;
    if (rt.hoveredId && !rt.nodeIndexById.has(rt.hoveredId)) rt.hoveredId = null;
    rt.alpha = 0.12;
    rt.measureLabels();
    rt.requestTick();
  }, [nodes, edges]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const prev = rt.selectedId;
    rt.selectedId = selectedId;
    rt.inspectorOpen = inspectorOpen;
    if (selectedId && selectedId !== prev) {
      rt.focusNodeToFront(selectedId);
    }
    rt.requestTick();
  }, [selectedId, inspectorOpen]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.autoOrbit = autoOrbit;
    if (autoOrbit) {
      rt.targetYaw = null;
      rt.targetPitch = null;
    }
    rt.requestTick();
  }, [autoOrbit]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt || zoomRequest.seq === 0) return;
    rt.targetZoom = Math.max(
      sceneSpec.camera.minZoom,
      Math.min(sceneSpec.camera.maxZoom, rt.targetZoom * zoomRequest.factor),
    );
    rt.requestTick();
  }, [zoomRequest]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt || resetRequest === 0) return;
    rt.targetYaw = sceneSpec.camera.initialYaw;
    rt.targetPitch = sceneSpec.camera.initialPitch;
    rt.velYaw = 0;
    rt.velPitch = 0;
    rt.targetZoom = 1;
    rt.requestTick();
  }, [resetRequest]);

  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt || reheatRequest === 0) return;
    rt.simNodes.forEach((n, idx) => {
      const phi = idx * 2.39996;
      n.vx += Math.cos(phi) * 8;
      n.vy += Math.sin(phi * 1.7) * 8;
      n.vz += Math.sin(phi) * 8;
    });
    rt.alpha = 0.65;
    rt.requestTick();
  }, [reheatRequest]);

  return <canvas ref={canvasRef} className="kg-sphere-canvas" />;
}
