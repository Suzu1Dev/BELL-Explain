import { z } from "zod";
import type { ChatCall } from "./ai.js";
import { AppError, schemaFailure } from "./errors.js";
import { logEvent } from "./log.js";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;

const freshId = (base: string, taken: Set<string>, prefix: string) => {
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 34);
  const start = /^[a-zA-Z]/.test(cleaned) ? cleaned : `${prefix}${cleaned}`.slice(0, 34);
  let id = start;
  for (let suffix = 2; taken.has(id) || !ID.test(id); suffix++) id = `${start}-${suffix}`;
  return id;
};
/**
 * Ids a repair renamed in place: same list length, and the element at that
 * position differs only in its id, whose old value is gone. A list that grew,
 * shrank or was rewritten tells nothing reliable, so references are left alone
 * for normalization or the next round.
 */
function renamedAt(before: unknown, after: Json[]): Map<string, string> {
  const renames = new Map<string, string>();
  const old = array(before);
  if (old.length !== after.length) return renames;
  const current = new Set(after.map((item) => item.id));
  const withoutId = (item: Json) => JSON.stringify({ ...item, id: undefined });
  after.forEach((item, index) => {
    const previous = old[index];
    if (!isObject(previous) || typeof previous.id !== "string" || typeof item.id !== "string") return;
    if (previous.id !== item.id && !current.has(previous.id) && withoutId(previous) === withoutId(item)) renames.set(previous.id, item.id);
  });
  return renames;
}

/**
 * Last resort for a teacher reply after repair: connections whose ends are
 * missing or the same node are only decoration, so they are dropped (with the
 * steps' references to them) rather than losing the whole lesson.
 */
export function dropDanglingEdges(input: unknown): { value: unknown; fixes: string[] } {
  if (!isObject(input) || !isObject(input.visual) || !isObject(input.visual.scene) || !Array.isArray(input.visual.scene.edges)) return { value: input, fixes: [] };
  const value = structuredClone(input) as Json;
  const visual = value.visual as Json;
  const scene = visual.scene as Json;
  const nodes = new Set(array(visual.nodes).filter(isObject).map((node) => node.id));
  const fixes: string[] = [];
  const dropped = new Set<unknown>();
  scene.edges = (scene.edges as unknown[]).filter((edge, index) => {
    if (!isObject(edge) || (nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to)) return true;
    dropped.add(edge.id);
    fixes.push(`visual.scene.edges.${index}`);
    return false;
  });
  if (dropped.size)
    for (const step of array(visual.steps).filter(isObject))
      if (Array.isArray(step.activeEdgeIds)) step.activeEdgeIds = step.activeEdgeIds.filter((id) => !dropped.has(id));
  return { value, fixes };
}

/**
 * Fixes ids and indices in a teacher reply that the server can settle without the
 * model: section ids, the visual kind, step indices out of range, invalid or
 * repeated node and edge ids (renamed together with every reference to them),
 * stale references in steps, and duplicate focus entries. Connections whose ends
 * do not exist are left for the model to fix. Text is never shortened and
 * walkthrough line numbers are left for the model, since only it knows the code.
 * Given the reply before a repair, ids the repair renamed carry their references along.
 * Returns a copy and the paths it changed.
 */
export function normalizeTeaching(input: unknown, previous?: unknown): { value: unknown; fixes: string[] } {
  if (!isObject(input)) return { value: input, fixes: [] };
  const value = structuredClone(input) as Json;
  const fixes: string[] = [];
  const sections = array(value.sections).filter(isObject);
  sections.forEach((section, index) => {
    if (typeof section.id !== "string" || !section.id) { section.id = `section-${index + 1}`; fixes.push(`sections.${index}.id`); }
  });
  const visual = value.visual;
  if (!isObject(visual)) return { value, fixes };
  if (visual.kind !== "flow") { visual.kind = "flow"; fixes.push("visual.kind"); }
  const before = isObject(previous) && isObject(previous.visual) ? previous.visual : undefined;

  const nodes = array(visual.nodes).filter(isObject);
  const nodeRename = renamedAt(before?.nodes, nodes);
  const taken = new Set(nodes.flatMap((node) => (typeof node.id === "string" ? [node.id] : [])));
  const nodeIds = new Set<string>();
  const seenNodes = new Set<string>();
  nodes.forEach((node, index) => {
    const id = node.id;
    if (typeof id !== "string") return;
    const repeated = seenNodes.has(id);
    seenNodes.add(id);
    if (!repeated && ID.test(id)) { nodeIds.add(id); return; }
    const next = freshId(id, taken, "n");
    taken.add(next);
    // An invalid but unique id is renamed along with its references; a repeated one leaves them on the first.
    if (!repeated) nodeRename.set(id, next);
    node.id = next;
    nodeIds.add(next);
    fixes.push(`visual.nodes.${index}.id`);
  });
  const mapNode = (id: unknown) => (typeof id === "string" ? nodeRename.get(id) ?? id : id);

  const scene = isObject(visual.scene) ? visual.scene : undefined;
  const edges = scene && Array.isArray(scene.edges) ? scene.edges.filter(isObject) : undefined;
  const edgeRename = renamedAt(isObject(before?.scene) ? before.scene.edges : undefined, edges ?? []);
  const edgeIds = new Set<string>();
  if (edges) {
    const takenEdges = new Set(edges.flatMap((edge) => (typeof edge.id === "string" ? [edge.id] : [])));
    const seenEdges = new Set<string>();
    edges.forEach((edge, index) => {
      const from = mapNode(edge.from), to = mapNode(edge.to);
      if (from !== edge.from || to !== edge.to) { edge.from = from; edge.to = to; fixes.push(`visual.scene.edges.${index}`); }
      const id = edge.id;
      if (typeof id !== "string") return;
      const repeated = seenEdges.has(id);
      seenEdges.add(id);
      if (!repeated && ID.test(id)) { edgeIds.add(id); return; }
      const next = freshId(id, takenEdges, "e");
      takenEdges.add(next);
      if (!repeated) edgeRename.set(id, next);
      edge.id = next;
      edgeIds.add(next);
      fixes.push(`visual.scene.edges.${index}.id`);
    });
  }
  if (scene && Array.isArray(scene.groups)) {
    scene.groups = scene.groups.flatMap((group, index) => {
      if (!isObject(group) || !Array.isArray(group.nodeIds)) return [group];
      const mapped = group.nodeIds.map(mapNode);
      const kept = mapped.filter((id) => typeof id === "string" && nodeIds.has(id));
      if (kept.length === group.nodeIds.length && mapped.every((id, position) => id === (group.nodeIds as unknown[])[position])) return [group];
      fixes.push(`visual.scene.groups.${index}.nodeIds`);
      return kept.length ? [{ ...group, nodeIds: kept }] : [];
    });
  }

  const steps = array(visual.steps).filter(isObject);
  steps.forEach((step, index) => {
    if (Array.isArray(step.activeNodeIds)) {
      const mapped = step.activeNodeIds.map(mapNode);
      const kept = [...new Set(mapped.filter((id) => typeof id === "string" && nodeIds.has(id)))];
      // An empty list stays invalid so the model is asked; a step must highlight something.
      const next = kept.length ? kept : mapped;
      if (JSON.stringify(next) !== JSON.stringify(step.activeNodeIds)) { step.activeNodeIds = next; fixes.push(`visual.steps.${index}.activeNodeIds`); }
    }
    if (Array.isArray(step.activeEdgeIds)) {
      const mapped = step.activeEdgeIds.map((id) => (typeof id === "string" ? edgeRename.get(id) ?? id : id));
      // Without a readable list of connections there is nothing to check references against.
      const kept = edges ? [...new Set(mapped.filter((id) => typeof id === "string" && edgeIds.has(id)))] : mapped;
      if (JSON.stringify(kept) !== JSON.stringify(step.activeEdgeIds)) { step.activeEdgeIds = kept; fixes.push(`visual.steps.${index}.activeEdgeIds`); }
    }
    if (Array.isArray(step.nodeStates)) {
      const seen = new Set<string>();
      const kept = step.nodeStates.flatMap((state) => {
        if (!isObject(state)) return [];
        const nodeId = mapNode(state.nodeId);
        if (typeof nodeId !== "string" || !nodeIds.has(nodeId) || seen.has(nodeId)) return [];
        seen.add(nodeId);
        return [nodeId === state.nodeId ? state : { ...state, nodeId }];
      });
      if (JSON.stringify(kept) !== JSON.stringify(step.nodeStates)) { step.nodeStates = kept; fixes.push(`visual.steps.${index}.nodeStates`); }
    }
  });
  if (steps.length)
    sections.forEach((section, index) => {
      if (typeof section.visualStep !== "number" || !Number.isFinite(section.visualStep)) return;
      const step = Math.min(Math.max(Math.round(section.visualStep), 0), steps.length - 1);
      if (step !== section.visualStep) { section.visualStep = step; fixes.push(`sections.${index}.visualStep`); }
    });

  const illustration = isObject(visual.illustration) ? visual.illustration : undefined;
  if (illustration && Array.isArray(illustration.focus)) {
    const seen = new Set<number>();
    const kept = illustration.focus.filter((item) => {
      if (!isObject(item) || typeof item.sectionIndex !== "number") return true;
      if (item.sectionIndex >= sections.length || seen.has(item.sectionIndex)) return false;
      seen.add(item.sectionIndex);
      return true;
    });
    if (kept.length !== illustration.focus.length) { illustration.focus = kept; fixes.push("visual.illustration.focus"); }
  }
  return { value, fixes };
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const patchSchema = z.object({
  fixes: z.array(z.object({
    path: z.array(z.union([z.string().min(1).max(80), z.number().int().min(0).max(999)])).min(1).max(12),
    value: z.unknown(),
  }).strict()).min(1).max(24),
}).strict();
type Path = Array<string | number>;
const startsWith = (path: Path, prefix: Path) => prefix.every((part, index) => String(path[index]) === String(part));

/** Arrays in a lesson are short; an index beyond this is not a fix. */
const MAX_INDEX = 64;
const INDEX = /^(0|[1-9]\d{0,2})$/;
/**
 * Applies `{path, value}` fixes in place; a fix outside the reported problems is
 * refused, as is any step through a non-container, a non-index key on an array,
 * an index past the end, or a prototype key.
 */
export function applyFixes(target: unknown, fixes: Array<{ path: Path; value: unknown }>, allowed: Path[]): number {
  let applied = 0;
  for (const { path, value } of fixes) {
    if (path.some((part) => FORBIDDEN.has(String(part)))) continue;
    if (!allowed.some((prefix) => startsWith(path, prefix))) continue;
    let node: unknown = target;
    for (const [position, part] of path.entries()) {
      let key: string | number;
      if (Array.isArray(node)) {
        const index = typeof part === "number" ? part : INDEX.test(part) ? Number(part) : NaN;
        if (!Number.isInteger(index) || index > node.length || index > MAX_INDEX) break;
        key = index;
      } else if (isObject(node) && typeof part === "string") key = part;
      else break;
      const container = node as Record<string | number, unknown>;
      if (position === path.length - 1) { container[key] = value; applied++; break; }
      if (container[key] === undefined) {
        const next = path[position + 1];
        container[key] = typeof next === "number" || INDEX.test(String(next)) ? [] : {};
      }
      node = container[key];
    }
  }
  return applied;
}

/**
 * Parses `value`, first dropping keys a strict object does not know: they hold nothing the
 * schema would keep, and a repair can only set values, so the model could never remove them.
 */
export function parseDroppingUnknownKeys<T>(schema: z.ZodType<T>, value: unknown, name: string): { value: unknown; result: z.ZodSafeParseResult<T> } {
  let result = schema.safeParse(value);
  // Dropping keys never makes new unknown ones; the bound only guards against a schema that keeps reporting them.
  for (let round = 0; !result.success && round < 3; round++) {
    const extra = result.error.issues.filter(issue => issue.code === "unrecognized_keys");
    if (!extra.length) break;
    value = structuredClone(value);
    const dropped: string[] = [];
    for (const issue of extra) {
      const node = issue.path.reduce<unknown>((parent, part) => (isObject(parent) || Array.isArray(parent) ? (parent as Record<PropertyKey, unknown>)[part] : undefined), value);
      if (!isObject(node)) continue;
      for (const key of issue.keys) if (Object.hasOwn(node, key)) { delete node[key]; dropped.push([...issue.path, key].map(String).join(".")); }
    }
    if (!dropped.length) break;
    logEvent("schema.normalized", { stage: name, fixes: dropped.slice(0, 20), total: dropped.length });
    result = schema.safeParse(value);
  }
  return { value, result };
}

const valueAt = (root: unknown, path: Path) => path.reduce<unknown>((node, part) => (typeof node === "object" && node !== null ? (node as Record<string | number, unknown>)[part] : undefined), root);
const MAX_CONTEXT = 60_000;

/** Repair rounds: refinements across fields only run once the shape is valid, so a second round may surface new issues. */
export const REPAIR_ROUNDS = 2;

/**
 * Validates a model reply. When validation fails, asks the same agent for patches
 * to just the reported paths, applies them, and validates again, for up to
 * REPAIR_ROUNDS rounds. A reply still invalid after that is reported as before,
 * so nothing invalid is ever saved.
 */
export async function validatedWithRepair<T>(options: {
  schema: z.ZodType<T>;
  value: unknown;
  name: string;
  /** The agent asked for fixes; defaults to `name`. */
  role?: string;
  message: string;
  chat: ChatCall;
  signal: AbortSignal;
  normalize?: (value: unknown, previous?: unknown) => { value: unknown; fixes: string[] };
  /** Applied once when the repair rounds are exhausted, before giving up. */
  fallback?: (value: unknown) => { value: unknown; fixes: string[] };
  onRepair?: (count: number) => void;
}): Promise<T> {
  const { schema, name, chat, signal, normalize } = options;
  const prepare = (input: unknown, previous?: unknown) => {
    if (!normalize) return input;
    const normalized = normalize(input, previous);
    if (normalized.fixes.length) logEvent("schema.normalized", { stage: name, fixes: normalized.fixes.slice(0, 20), total: normalized.fixes.length });
    return normalized.value;
  };
  let { value, result } = parseDroppingUnknownKeys(schema, prepare(options.value), name);
  // A reply that is not an object (null, a number, text) has no fields to patch.
  for (let round = 1; !result.success && isObject(value) && round <= REPAIR_ROUNDS; round++) {
    const issues = result.error.issues.slice(0, 20);
    schemaFailure(name, options.message, result.error);
    options.onRepair?.(issues.length);
    signal.throwIfAborted();
    const paths = issues.map((issue) => issue.path.map((part) => (typeof part === "number" ? part : String(part))));
    const serialized = JSON.stringify(value);
    // The whole reply when it fits, otherwise just the parts with problems and their parents.
    const context = serialized.length <= MAX_CONTEXT
      ? { output: value }
      : { parts: paths.map((path) => ({ path, value: valueAt(value, path), parent: path.length ? valueAt(value, path.slice(0, -1)) : undefined })) };
    let patch: z.infer<typeof patchSchema>;
    try {
      const reply = await chat(
        options.role ?? name,
        `你上一次的 JSON 回覆有結構問題，伺服器無法儲存。只修正 issues 列出的位置，不要改寫其他內容。回傳 {"fixes":[{"path":[...],"value":...}]}：path 是從回覆根部開始的鍵與零起算索引，必須落在某個 issue 的 path 之內（可以更深）；value 是該位置修正後的完整值。例如逐行解說行號超出範圍時，依同一段落的 code 改正 startLine／endLine；引用不存在的節點時改成存在的 id。只回傳 fixes。JSON schema：${JSON.stringify(z.toJSONSchema(patchSchema))}`,
        { issues: issues.map((issue, index) => ({ path: paths[index], message: issue.message })), ...context },
        signal,
      );
      patch = patchSchema.parse(reply);
    } catch (error) {
      signal.throwIfAborted();
      // A rate limit refuses the next call too: end the job here rather than spend another attempt.
      if (error instanceof AppError && error.status === 429) {
        logEvent("schema.repair", { stage: name, round, outcome: "rate-limited" });
        throw error;
      }
      logEvent("schema.repair", { stage: name, round, outcome: "no-patch", error: error instanceof Error ? error.name : "unknown" });
      break;
    }
    const repaired = structuredClone(value);
    const applied = applyFixes(repaired, patch.fixes as Array<{ path: Path; value: unknown }>, paths);
    ({ value, result } = parseDroppingUnknownKeys(schema, prepare(repaired, value), name));
    logEvent("schema.repair", { stage: name, round, outcome: result.success ? "fixed" : "still-invalid", issues: issues.length, fixes: patch.fixes.length, applied });
  }
  if (!result.success && options.fallback) {
    const last = options.fallback(value);
    if (last.fixes.length) {
      result = schema.safeParse(last.value);
      logEvent("schema.fallback", { stage: name, fixes: last.fixes.slice(0, 20), outcome: result.success ? "fixed" : "still-invalid" });
    }
  }
  if (result.success) return result.data;
  throw schemaFailure(name, options.message, result.error);
}
