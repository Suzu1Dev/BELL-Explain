import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, GitBranch, Hash, Maximize2, Minus, Orbit, Plus, RotateCcw, Search, X } from "lucide-react";
import { isLessonV3, type StoredLesson } from "../../shared/lesson-v3";
import { fill, learningCopy } from "../copy/learning";
import sceneSpec from "./knowledge-scene.json";
import KnowledgeScene3D from "./KnowledgeScene3D";
import "./knowledge-graph.css";

const MAX_NOTES = 36;
const MAX_TOPICS = 10;
const TONE_COUNT = sceneSpec.palettes.dark.tones.length;

export interface SimNode {
  id: string;
  kind: "note" | "topic";
  tier: 0 | 1 | 2;
  label: string;
  shortLabel: string;
  targetR: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  degree: number;
  tone: number;
  category?: string;
  lesson?: StoredLesson;
  tag?: string;
  count?: number;
}

export interface SimEdge {
  key: string;
  from: string;
  to: string;
  kind: "link" | "follow" | "topic" | "shared";
  reason?: string;
}

function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 255 ? 1 : 0.56;
  return width;
}

function trimVisual(text: string, maxUnits: number): string {
  if (visualWidth(text) <= maxUnits) return text;
  let acc = 0;
  let out = "";
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 255 ? 1 : 0.56;
    if (acc + w > maxUnits - 0.8) break;
    acc += w;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

function cleanSummary(lesson: StoredLesson): string {
  const raw = isLessonV3(lesson) ? lesson.answer : lesson.summary;
  return raw.replace(/\*\*(.+?)\*\*/g, "$1");
}

// shortcut: O(V^2) 3D spherical spring-repulsion layout capped at 36 notes + 10 topic anchors, switch to Barnes-Hut octree above ~300 nodes
export function stepSimulation(nodes: SimNode[], edges: SimEdge[], alpha: number, pinnedId?: string | null): void {
  const byId = new Map(nodes.map(node => [node.id, node]));

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = b.x - a.x || (i % 2 ? 0.5 : -0.5);
      const dy = b.y - a.y || ((i + j) % 2 ? 0.5 : -0.5);
      const dz = b.z - a.z || (j % 2 ? 0.5 : -0.5);
      const distSq = dx * dx + dy * dy + dz * dz + 110;
      const dist = Math.sqrt(distSq);
      const strength =
        a.kind === "note" && b.kind === "note"
          ? sceneSpec.sphere.repulsionNote
          : sceneSpec.sphere.repulsionTopic;
      const force = (strength * alpha) / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      a.vz -= fz;
      b.vx += fx;
      b.vy += fy;
      b.vz += fz;
    }
  }

  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const rest = edge.kind === "topic" ? sceneSpec.sphere.springTopicLength : sceneSpec.sphere.springLinkLength;
    const stiffness = edge.kind === "topic" ? 0.024 : edge.kind === "shared" ? 0.022 : 0.056;
    const pull = (dist - rest) * stiffness * alpha;
    const fx = (dx / dist) * pull;
    const fy = (dy / dist) * pull;
    const fz = (dz / dist) * pull;
    a.vx += fx;
    a.vy += fy;
    a.vz += fz;
    b.vx -= fx;
    b.vy -= fy;
    b.vz -= fz;
  }

  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const node of nodes) {
    mx += node.x;
    my += node.y;
    mz += node.z;
  }
  const invN = nodes.length > 0 ? 1 / nodes.length : 0;
  mx *= invN;
  my *= invN;
  mz *= invN;

  for (const node of nodes) {
    if (node.id === pinnedId) {
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
      continue;
    }
    node.vx -= mx * 0.036 * alpha;
    node.vy -= my * 0.036 * alpha;
    node.vz -= mz * 0.036 * alpha;

    const r = Math.hypot(node.x, node.y, node.z) || 1;
    const radialPull = (node.targetR - r) * sceneSpec.sphere.shellStiffness * alpha;
    node.vx += (node.x / r) * radialPull;
    node.vy += (node.y / r) * radialPull;
    node.vz += (node.z / r) * radialPull;

    node.vx *= sceneSpec.sphere.damping;
    node.vy *= sceneSpec.sphere.damping;
    node.vz *= sceneSpec.sphere.damping;

    const step = Math.hypot(node.vx, node.vy, node.vz);
    if (step > 22) {
      const scale = 22 / step;
      node.vx *= scale;
      node.vy *= scale;
      node.vz *= scale;
    }
    node.x += node.vx;
    node.y += node.vy;
    node.z += node.vz;
  }
}

export function buildKnowledgeGraph(
  lessons: StoredLesson[],
  options: { category?: string; query?: string; showTopics?: boolean; followUpReason?: string; sharedReason?: (tags: string[]) => string } = {},
) {
  const categories = [...new Set(lessons.map(item => item.category))];
  const toneByCategory = new Map(categories.map((cat, index) => [cat, index % TONE_COUNT]));
  const catCounts = new Map<string, number>();
  for (const lesson of lessons) catCounts.set(lesson.category, (catCounts.get(lesson.category) ?? 0) + 1);

  const q = (options.query ?? "").trim().toLowerCase();
  const showTopics = options.showTopics ?? true;

  const filtered = lessons.filter(lesson => {
    if (options.category && options.category !== "all" && lesson.category !== options.category) return false;
    if (!q) return true;
    const hay = `${lesson.title}\n${lesson.category}\n${lesson.tags.join(" ")}\n${cleanSummary(lesson)}`.toLowerCase();
    return hay.includes(q);
  });

  const visible = filtered.slice(0, MAX_NOTES);
  const visibleIds = new Set(visible.map(item => item.id));

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const lesson of visible) {
    for (const conn of lesson.connections) {
      if (visibleIds.has(conn.targetId) && conn.targetId !== lesson.id) {
        outDeg.set(lesson.id, (outDeg.get(lesson.id) ?? 0) + 1);
        inDeg.set(conn.targetId, (inDeg.get(conn.targetId) ?? 0) + 1);
      }
    }
    if (lesson.parentLessonId && visibleIds.has(lesson.parentLessonId)) {
      outDeg.set(lesson.id, (outDeg.get(lesson.id) ?? 0) + 1);
      inDeg.set(lesson.parentLessonId, (inDeg.get(lesson.parentLessonId) ?? 0) + 1);
    }
  }

  const classifyNoteTier = (lesson: StoredLesson): 1 | 2 => {
    if (lesson.parentLessonId) return 2;
    const incoming = inDeg.get(lesson.id) ?? 0;
    const outgoing = outDeg.get(lesson.id) ?? 0;
    if (outgoing > incoming) return 2;
    if (outgoing > 0 && (lesson.tags.length >= 7 || (incoming === outgoing && (catCounts.get(lesson.category) ?? 1) === 1))) {
      return 2;
    }
    return 1;
  };

  const tagCounts = new Map<string, number>();
  for (const lesson of visible) {
    for (const tag of lesson.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sharedTags = sortedTags.filter(([, count]) => count >= 2).slice(0, MAX_TOPICS);
  const selectedTags = showTopics
    ? (sharedTags.length >= 3 || visible.length > 3
      ? sharedTags.length > 0 ? sharedTags : sortedTags.slice(0, Math.min(5, sortedTags.length))
      : sortedTags.slice(0, Math.min(6, sortedTags.length)))
    : [];

  const activeCategories = [...new Set(visible.map(item => item.category))];
  const catBuckets = new Map<string, StoredLesson[]>();
  for (const lesson of visible) {
    const bucket = catBuckets.get(lesson.category) ?? [];
    bucket.push(lesson);
    catBuckets.set(lesson.category, bucket);
  }

  // Longitude-sectored spherical belt distribution so domains spread horizontally around the globe instead of piling at poles
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const nodes: SimNode[] = [];

  visible.forEach(lesson => {
    const nTotal = Math.max(1, visible.length);
    const catIdx = Math.max(0, activeCategories.indexOf(lesson.category));
    const bucket = catBuckets.get(lesson.category) ?? [lesson];
    const localIdx = bucket.indexOf(lesson);
    const sector = (catIdx / Math.max(1, activeCategories.length)) * Math.PI * 2;
    const localOffset = ((localIdx - (bucket.length - 1) * 0.5) / Math.max(1, bucket.length)) * 1.05;
    const theta = sector + localOffset;
    const yNorm = nTotal === 1 ? 0 : Math.sin(localIdx * 1.9 + catIdx * 1.15) * 0.62;
    const ring = Math.sqrt(Math.max(0.15, 1 - yNorm * yNorm));
    const baseR = nTotal === 1 ? 0 : sceneSpec.sphere.noteRadius;
    const tier = classifyNoteTier(lesson);

    nodes.push({
      id: `note:${lesson.id}`,
      kind: "note",
      tier,
      label: lesson.title,
      shortLabel: trimVisual(lesson.title, 15),
      targetR: baseR,
      x: Math.cos(theta) * ring * baseR,
      y: yNorm * baseR,
      z: Math.sin(theta) * ring * baseR,
      vx: 0,
      vy: 0,
      vz: 0,
      degree: 0,
      tone: toneByCategory.get(lesson.category) ?? 0,
      category: lesson.category,
      lesson,
    });
  });

  const noteNodeByLessonId = new Map(nodes.map(node => [node.lesson!.id, node]));

  selectedTags.forEach(([tag, count], idx) => {
    const owners = visible
      .filter(lesson => lesson.tags.includes(tag))
      .map(lesson => noteNodeByLessonId.get(lesson.id)!);
    let cx = owners.length ? owners.reduce((sum, item) => sum + item.x, 0) / owners.length : 0;
    let cy = owners.length ? owners.reduce((sum, item) => sum + item.y, 0) / owners.length : 0;
    let cz = owners.length ? owners.reduce((sum, item) => sum + item.z, 0) / owners.length : 0;
    const a = idx * goldenAngle;
    cx += Math.cos(a) * 28;
    cy += Math.sin(a * 1.3) * 28;
    cz += Math.sin(a) * 28;
    const len = Math.hypot(cx, cy, cz) || 1;
    const tr = sceneSpec.sphere.topicRadius;

    nodes.push({
      id: `topic:${tag}`,
      kind: "topic",
      tier: 0,
      label: tag,
      shortLabel: trimVisual(tag, 12),
      targetR: tr,
      x: (cx / len) * tr,
      y: (cy / len) * tr,
      z: (cz / len) * tr,
      vx: 0,
      vy: 0,
      vz: 0,
      degree: count,
      tone: 0,
      tag,
      count,
    });
  });

  const pairMap = new Map<string, { from: string; to: string; reasons: string[]; kind: "link" | "follow" }>();
  const addNoteLink = (fromLessonId: string, toLessonId: string, kind: "link" | "follow", reason: string) => {
    const a = noteNodeByLessonId.get(fromLessonId);
    const b = noteNodeByLessonId.get(toLessonId);
    if (!a || !b || a.id === b.id) return;
    const pairKey = `${kind}:${[a.id, b.id].sort().join("|")}`;
    const existing = pairMap.get(pairKey) ?? { from: a.id, to: b.id, reasons: [], kind };
    if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
    pairMap.set(pairKey, existing);
  };

  for (const lesson of visible) {
    for (const conn of lesson.connections) addNoteLink(lesson.id, conn.targetId, "link", conn.reason);
    if (lesson.parentLessonId) addNoteLink(lesson.id, lesson.parentLessonId, "follow", options.followUpReason ?? "Follow-up");
  }

  const edges: SimEdge[] = [];
  for (const [key, pair] of pairMap) {
    edges.push({ key, from: pair.from, to: pair.to, kind: pair.kind, reason: pair.reasons.join(" · ") });
  }

  if (showTopics) {
    for (const [tag] of selectedTags) {
      const topicId = `topic:${tag}`;
      for (const lesson of visible) {
        if (lesson.tags.includes(tag)) {
          edges.push({ key: `topic:${lesson.id}->${tag}`, from: `note:${lesson.id}`, to: topicId, kind: "topic" });
        }
      }
    }
  } else {
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i];
        const b = visible[j];
        const aId = `note:${a.id}`;
        const bId = `note:${b.id}`;
        const hasDirect = edges.some(e => (e.from === aId && e.to === bId) || (e.from === bId && e.to === aId));
        if (hasDirect) continue;
        const common = a.tags.filter(t => b.tags.includes(t));
        if (common.length > 0) {
          edges.push({
            key: `shared:${a.id}|${b.id}`,
            from: aId,
            to: bId,
            kind: "shared",
            reason: options.sharedReason ? options.sharedReason(common) : common.join(", "),
          });
        }
      }
    }
  }

  const degreeMap = new Map<string, number>();
  for (const edge of edges) {
    const w = edge.kind === "link" || edge.kind === "follow" ? 2 : 1;
    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + w);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + w);
  }
  for (const node of nodes) {
    if (node.kind === "note") {
      node.degree = degreeMap.get(node.id) ?? 0;
      if (visible.length > 1) {
        node.targetR = node.degree >= 5 ? sceneSpec.sphere.hubRadius : sceneSpec.sphere.noteRadius;
      }
    }
  }

  for (let step = 0; step < 105; step++) {
    const alpha = Math.max(0.04, 0.92 * Math.pow(0.972, step));
    stepSimulation(nodes, edges, alpha);
  }

  return {
    categories: categories.map(cat => ({
      name: cat,
      tone: toneByCategory.get(cat) ?? 0,
      count: lessons.filter(item => item.category === cat).length,
    })),
    nodes,
    edges,
    noteCount: visible.length,
    topicCount: selectedTags.length,
    semanticLinkCount: pairMap.size,
  };
}

interface InspectorRelation {
  key: string;
  lessonId: string;
  sectionId?: string;
  title: string;
  label: string;
  reason: string;
}

export default function KnowledgeGraph({
  lessons,
  open,
  selectTag,
}: {
  lessons: StoredLesson[];
  open: (id: string, sectionId?: string) => void;
  selectTag: (tag: string) => void;
}) {
  const copy = learningCopy().graph;
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showTopics, setShowTopics] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoOrbit, setAutoOrbit] = useState(false);
  const [zoomRequest, setZoomRequest] = useState<{ factor: number; seq: number }>({ factor: 1, seq: 0 });
  const [resetSeq, setResetSeq] = useState(0);
  const [reheatSeq, setReheatSeq] = useState(0);

  const [listMode, setListMode] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 599px)").matches,
  );

  const graph = useMemo(
    () =>
      buildKnowledgeGraph(lessons, {
        category: categoryFilter,
        query: searchQuery,
        showTopics,
        followUpReason: copy.followUpLinkReason,
        sharedReason: tags => fill(copy.sharedConceptReason, { tags: tags.map(t => `#${t}`).join(", ") }),
      }),
    [lessons, categoryFilter, searchQuery, showTopics, copy.followUpLinkReason, copy.sharedConceptReason],
  );

  useEffect(() => {
    setSelectedId(prev => (prev && graph.nodes.some(n => n.id === prev) ? prev : null));
  }, [graph]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 599px)");
    const update = () => setListMode(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  if (!lessons.length) {
    return (
      <div className="empty-state">
        <GitBranch size={36} />
        <h3>{copy.emptyTitle}</h3>
        <p>{copy.emptyBody}</p>
      </div>
    );
  }

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const lessonById = new Map(lessons.map(item => [item.id, item]));

  const selectedRelations: InspectorRelation[] = (() => {
    if (!selectedNode || selectedNode.kind !== "note" || !selectedNode.lesson) return [];
    const current = selectedNode.lesson;
    const list: InspectorRelation[] = [];
    const seen = new Set<string>();
    const push = (rel: InspectorRelation) => {
      if (rel.lessonId === current.id || seen.has(rel.lessonId)) return;
      seen.add(rel.lessonId);
      list.push(rel);
    };
    if (current.parentLessonId) {
      const parent = lessonById.get(current.parentLessonId);
      if (parent) push({ key: `parent:${parent.id}`, lessonId: parent.id, title: parent.title, label: copy.relationContinues, reason: copy.relationParentReason });
    }
    for (const conn of current.connections) {
      const target = lessonById.get(conn.targetId);
      if (target) push({ key: `out:${target.id}`, lessonId: target.id, sectionId: conn.sectionId, title: target.title, label: copy.relationLinksTo, reason: conn.reason });
    }
    for (const other of lessons) {
      if (other.id === current.id) continue;
      if (other.parentLessonId === current.id) {
        push({ key: `child:${other.id}`, lessonId: other.id, title: other.title, label: copy.relationContinuedBy, reason: copy.relationChildReason });
      }
      for (const conn of other.connections) {
        if (conn.targetId === current.id) {
          push({ key: `in:${other.id}`, lessonId: other.id, sectionId: conn.sectionId, title: other.title, label: copy.relationLinkedFrom, reason: conn.reason });
        }
      }
    }
    for (const other of lessons) {
      if (other.id === current.id || seen.has(other.id)) continue;
      const shared = current.tags.filter(tag => other.tags.includes(tag));
      if (shared.length > 0) {
        push({
          key: `shared:${other.id}`,
          lessonId: other.id,
          title: other.title,
          label: copy.sharedConceptLabel,
          reason: fill(copy.sharedConceptReason, { tags: shared.map(t => `#${t}`).join(", ") }),
        });
      }
      if (list.length >= 6) break;
    }
    return list;
  })();

  const tierLabel = (tier: 0 | 1 | 2) =>
    tier === 2 ? copy.layerApplied : tier === 1 ? copy.layerCore : copy.layerTopic;

  const notesPart = lessons.length > MAX_NOTES
    ? fill(copy.footerNotesCapped, { shown: graph.noteCount, total: lessons.length })
    : fill(graph.noteCount === 1 ? copy.footerNotesOne : copy.footerNotes, { count: graph.noteCount });
  const topicsPart = fill(graph.topicCount === 1 ? copy.footerTopicsOne : copy.footerTopics, { topics: graph.topicCount });
  const linksPart = fill(graph.semanticLinkCount === 1 ? copy.footerLinksOne : copy.footerLinks, { links: graph.semanticLinkCount });
  const footerSummary = fill(copy.footerJoinLinks, { notesPart, topicsPart, linksPart });

  return (
    <div className="kg-panel graph-panel">
      <div className="kg-topbar">
        <div className="kg-categories" role="group" aria-label={copy.categoryFilterAria}>
          <button
            type="button"
            className="kg-cat-chip"
            aria-pressed={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
          >
            <span>{copy.allCategories}</span>
            <span className="kg-cat-count">{lessons.length}</span>
          </button>
          {graph.categories.map(cat => (
            <button
              key={cat.name}
              type="button"
              className="kg-cat-chip"
              aria-pressed={categoryFilter === cat.name}
              onClick={() => setCategoryFilter(prev => (prev === cat.name ? "all" : cat.name))}
            >
              <i className={`kg-cat-dot kg-tone-dot-${cat.tone}`} />
              <span>{cat.name}</span>
              <span className="kg-cat-count">{cat.count}</span>
            </button>
          ))}
        </div>

        <div className="kg-controls-right">
          <label className="kg-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={copy.searchPlaceholder}
              aria-label={copy.searchAria}
            />
            {searchQuery && (
              <button
                type="button"
                className="kg-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label={copy.clearSearchAria}
              >
                <X size={13} />
              </button>
            )}
          </label>

          {!listMode && (
            <button
              type="button"
              className="kg-topic-toggle"
              aria-pressed={showTopics}
              onClick={() => setShowTopics(value => !value)}
            >
              <Hash size={13} aria-hidden="true" />
              <span>{copy.toggleTopics}</span>
            </button>
          )}

          <div className="graph-view-toggle" role="group" aria-label={copy.viewToggleAria}>
            <button type="button" aria-pressed={!listMode} onClick={() => setListMode(false)}>{copy.viewMap}</button>
            <button type="button" aria-pressed={listMode} onClick={() => setListMode(true)}>{copy.viewList}</button>
          </div>
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <div className="kg-empty-filtered">
          <p>{copy.emptyFiltered}</p>
          <button
            type="button"
            onClick={() => {
              setCategoryFilter("all");
              setSearchQuery("");
            }}
          >
            {copy.resetFilters}
          </button>
        </div>
      ) : listMode ? (
        <div className="graph-list">
          {graph.nodes.filter(n => n.kind === "note" && n.lesson).map(n => {
            const lesson = n.lesson!;
            return (
              <article className="graph-list-note" key={lesson.id}>
                <button
                  type="button"
                  className="graph-list-open"
                  onClick={() => open(lesson.id)}
                  aria-label={fill(copy.openNoteAria, { title: lesson.title })}
                >
                  <strong>{lesson.title}</strong>
                  <span>{lesson.category}</span>
                </button>
                <div className="graph-list-tags">
                  {lesson.tags.map(tag => (
                    <button
                      type="button"
                      key={tag}
                      className="graph-list-tag"
                      onClick={() => selectTag(tag)}
                      aria-label={fill(copy.openTopicAria, { topic: tag })}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="kg-stage graph-viewport" role="region" aria-label={copy.viewportAria}>
          <KnowledgeScene3D
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            autoOrbit={autoOrbit}
            inspectorOpen={Boolean(selectedNode)}
            zoomRequest={zoomRequest}
            resetRequest={resetSeq}
            reheatRequest={reheatSeq}
            onSelectNode={setSelectedId}
            onOpenNode={node => {
              if (node.kind === "note" && node.lesson) open(node.lesson.id);
              else if (node.kind === "topic" && node.tag) selectTag(node.tag);
            }}
          />

          <div className="kg-a11y-layer sr-only" role="group" aria-label={copy.canvasAria}>
            {graph.nodes.map(node => {
              const isSelected = selectedId === node.id;
              if (node.kind === "topic") {
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-kg-node-id={node.id}
                    aria-label={fill(copy.openTopicAria, { topic: node.label })}
                    aria-pressed={isSelected}
                    className="kg-node-topic graph-topic"
                    onClick={() => setSelectedId(prev => (prev === node.id ? null : node.id))}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (isSelected && node.tag) selectTag(node.tag);
                        else setSelectedId(node.id);
                      }
                    }}
                  >
                    #{node.shortLabel}
                  </button>
                );
              }

              const lesson = node.lesson!;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-kg-node-id={node.id}
                  aria-label={fill(copy.openNoteAria, { title: lesson.title })}
                  aria-pressed={isSelected}
                  className={`kg-node-note graph-note graph-tone-${node.tone % 3}`}
                  onClick={() => setSelectedId(prev => (prev === node.id ? null : node.id))}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (isSelected) open(lesson.id);
                      else setSelectedId(node.id);
                    }
                  }}
                >
                  {node.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="kg-hud-bottom">
            <button
              type="button"
              className="kg-orbit-btn"
              aria-pressed={autoOrbit}
              aria-label={copy.orbitToggleAria}
              onClick={() => setAutoOrbit(v => !v)}
            >
              <Orbit size={13} aria-hidden="true" />
              <span>{copy.orbitToggle}</span>
            </button>

            <div className="kg-zoom-bar">
              <button
                type="button"
                aria-label={copy.zoomOutAria}
                title={copy.zoomOutAria}
                onClick={() => setZoomRequest(prev => ({ factor: 1 / 1.24, seq: prev.seq + 1 }))}
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                aria-label={copy.zoomInAria}
                title={copy.zoomInAria}
                onClick={() => setZoomRequest(prev => ({ factor: 1.24, seq: prev.seq + 1 }))}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                aria-label={copy.resetViewAria}
                title={copy.resetViewAria}
                onClick={() => setResetSeq(v => v + 1)}
              >
                <Maximize2 size={13} />
              </button>
              <button
                type="button"
                aria-label={copy.reheatLayoutAria}
                title={copy.reheatLayoutAria}
                onClick={() => setReheatSeq(v => v + 1)}
              >
                <RotateCcw size={13} />
              </button>
            </div>

            <div className="kg-legend-pill" aria-label={copy.legendAria}>
              <span className="kg-legend-item"><i className="kg-legend-sphere" />{copy.legendNote}</span>
              {showTopics && <span className="kg-legend-item"><i className="kg-legend-topic" />{copy.legendTopic}</span>}
              <span className="kg-legend-item"><i className="kg-legend-line" />{copy.legendLink}</span>
            </div>
          </div>

          {selectedNode && (
            <aside className="kg-inspector" aria-label={copy.inspectorAria}>
              <div className="kg-inspector-top">
                <div className="kg-inspector-badges">
                  {selectedNode.kind === "note" && selectedNode.lesson ? (
                    <span className="kg-inspector-badge">
                      <i className={`kg-cat-dot kg-tone-dot-${selectedNode.tone}`} />
                      <span>{selectedNode.lesson.category}</span>
                    </span>
                  ) : (
                    <span className="kg-inspector-badge">
                      <Hash size={12} />
                      <span>{fill((selectedNode.count ?? 0) === 1 ? copy.footerNotesOne : copy.footerNotes, { count: selectedNode.count ?? 0 })}</span>
                    </span>
                  )}
                  <span className="kg-inspector-layer">{tierLabel(selectedNode.tier)}</span>
                </div>
                <button
                  type="button"
                  className="kg-inspector-close"
                  onClick={() => setSelectedId(null)}
                  aria-label={copy.closeInspectorAria}
                >
                  <X size={15} />
                </button>
              </div>

              {selectedNode.kind === "note" && selectedNode.lesson ? (
                <>
                  <h3>{selectedNode.lesson.title}</h3>
                  <p className="kg-inspector-summary">{cleanSummary(selectedNode.lesson)}</p>
                  <button
                    type="button"
                    className="kg-inspector-cta"
                    onClick={() => open(selectedNode.lesson!.id)}
                  >
                    <span>{copy.openNoteButton}</span>
                    <ArrowUpRight size={15} />
                  </button>

                  <div className="kg-inspector-section">
                    <h4>{copy.connectionsHeading}</h4>
                    {selectedRelations.length === 0 ? (
                      <p className="kg-inspector-empty">{copy.noConnections}</p>
                    ) : (
                      <div className="kg-relation-list">
                        {selectedRelations.map(rel => {
                          const onCanvas = nodeById.has(`note:${rel.lessonId}`);
                          return (
                            <div className="kg-relation-card" key={rel.key}>
                              <div className="kg-relation-head">
                                <span className="kg-relation-kind">{rel.label}</span>
                                <button
                                  type="button"
                                  className="kg-relation-jump"
                                  aria-label={fill(copy.jumpToNoteAria, { title: rel.title })}
                                  title={fill(copy.jumpToNoteAria, { title: rel.title })}
                                  onClick={() => open(rel.lessonId, rel.sectionId)}
                                >
                                  <ArrowUpRight size={14} />
                                </button>
                              </div>
                              <button
                                type="button"
                                className="kg-relation-focus"
                                onClick={() => (onCanvas ? setSelectedId(`note:${rel.lessonId}`) : open(rel.lessonId, rel.sectionId))}
                              >
                                {rel.title}
                              </button>
                              <p className="kg-relation-reason">{rel.reason}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {selectedNode.lesson.tags.length > 0 && (
                    <div className="kg-inspector-section">
                      <h4>{copy.sharedTopicsHeading}</h4>
                      <div className="kg-tag-chips">
                        {selectedNode.lesson.tags.map(tag => {
                          const topicNodeId = `topic:${tag}`;
                          const onCanvas = nodeById.has(topicNodeId);
                          return (
                            <button
                              key={tag}
                              type="button"
                              className="kg-tag-chip"
                              onClick={() => (onCanvas ? setSelectedId(topicNodeId) : selectTag(tag))}
                            >
                              <span>#</span>{tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h3>#{selectedNode.label}</h3>
                  <button
                    type="button"
                    className="kg-inspector-cta"
                    onClick={() => selectedNode.tag && selectTag(selectedNode.tag)}
                  >
                    <span>{copy.filterLibraryByTopic}</span>
                    <ArrowUpRight size={15} />
                  </button>

                  <div className="kg-inspector-section">
                    <h4>{copy.topicNotesHeading}</h4>
                    <div className="kg-relation-list">
                      {lessons.filter(item => item.tags.includes(selectedNode.label)).map(item => {
                        const onCanvas = nodeById.has(`note:${item.id}`);
                        return (
                          <div className="kg-relation-card" key={item.id}>
                            <div className="kg-relation-head">
                              <span className="kg-relation-kind">{item.category}</span>
                              <button
                                type="button"
                                className="kg-relation-jump"
                                aria-label={fill(copy.jumpToNoteAria, { title: item.title })}
                                onClick={() => open(item.id)}
                              >
                                <ArrowUpRight size={14} />
                              </button>
                            </div>
                            <button
                              type="button"
                              className="kg-relation-focus"
                              onClick={() => (onCanvas ? setSelectedId(`note:${item.id}`) : open(item.id))}
                            >
                              {item.title}
                            </button>
                            <p className="kg-relation-reason">{cleanSummary(item)}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      )}

      <div className="kg-footer graph-footer">
        <span>{footerSummary}</span>
        {!listMode && <span className="kg-footer-hint">{copy.canvasHint}</span>}
      </div>
    </div>
  );
}
