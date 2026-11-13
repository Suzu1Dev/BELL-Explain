/*
 * Lightweight declarative D2 subset for LessonV3 structural diagrams (`kind: "d2"`).
 * Authors write standard D2 containers, nodes and `a -> b: label` edges instead of
 * imperative coordinate code; the client lays cards out with CSS Grid and SVG curves.
 *
 * shortcut: supports single-level containers and binary/chained `->`/`<-`/`<->`/`--` edges, upgrade to a full D2 AST if nested containers or style blocks are needed.
 */

export interface D2Node {
  id: string;
  localId: string;
  title: string;
  detail?: string;
  groupId?: string;
}

export interface D2Group {
  id: string;
  label: string;
  nodes: D2Node[];
}

export interface D2Edge {
  from: string;
  to: string;
  label?: string;
  bidirectional?: boolean;
}

export interface D2Graph {
  direction: "right" | "down";
  groups: D2Group[];
  /** Standalone nodes not inside any group. */
  nodes: D2Node[];
  /** Every node in declaration order (grouped + standalone). */
  allNodes: D2Node[];
  edges: D2Edge[];
  errors: string[];
}

const maskInlineCode = (line: string) => line.replace(/(`+)[^`]*?\1/g, span => " ".repeat(span.length));

function unquote(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitNodeLabel(raw: string): { title: string; detail?: string } {
  const clean = unquote(raw);
  const masked = maskInlineCode(clean);
  for (const sep of [" · ", " | ", "｜"]) {
    const at = masked.indexOf(sep);
    if (at > 0) {
      const title = clean.slice(0, at).trim();
      const detail = clean.slice(at + sep.length).trim();
      if (title && detail) return { title, detail };
    }
  }
  return { title: clean };
}

function firstColonOutsideCode(text: string): number {
  return maskInlineCode(text).indexOf(":");
}

const ARROW_RE = /\s*(<->|->|<-|--)\s*/g;

export function parseD2(source: string): D2Graph {
  let direction: "right" | "down" = "right";
  const groups: D2Group[] = [];
  const standalone: D2Node[] = [];
  const nodeMap = new Map<string, D2Node>();
  const rawEdges: Array<{ from: string; to: string; label?: string; bidirectional?: boolean; scope?: string }> = [];
  const errors: string[] = [];
  let currentGroup: D2Group | undefined;

  const ensureNode = (id: string, rawLabel?: string, group?: D2Group): D2Node => {
    const existing = nodeMap.get(id);
    if (existing) {
      if (rawLabel !== undefined) {
        const { title, detail } = splitNodeLabel(rawLabel);
        existing.title = title;
        if (detail) existing.detail = detail;
      }
      return existing;
    }
    const localId = group ? id.slice(group.id.length + 1) : id;
    const { title, detail } = splitNodeLabel(rawLabel ?? localId);
    const node: D2Node = { id, localId, title, ...(detail ? { detail } : {}), ...(group ? { groupId: group.id } : {}) };
    nodeMap.set(id, node);
    if (group) group.nodes.push(node);
    else standalone.push(node);
    return node;
  };

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex].trim();
    if (!raw || raw.startsWith("#")) continue;

    if (raw === "}") {
      if (!currentGroup) errors.push(`第 ${lineIndex + 1} 行有多餘的 \`}\``);
      currentGroup = undefined;
      continue;
    }

    const masked = maskInlineCode(raw);

    // Direction header: `direction: right | down`
    const dirMatch = /^direction\s*:\s*([a-zA-Z-]+)\s*$/i.exec(raw);
    if (dirMatch && !currentGroup) {
      const val = dirMatch[1].toLowerCase();
      if (val === "down" || val === "up") direction = "down";
      else if (val === "right" || val === "left") direction = "right";
      else errors.push(`第 ${lineIndex + 1} 行不支援的 direction「${dirMatch[1]}」（請用 right 或 down）`);
      continue;
    }

    // Group open: `groupId: Label {` or `groupId {`
    if (masked.endsWith("{")) {
      if (currentGroup) {
        errors.push(`第 ${lineIndex + 1} 行不支援巢狀群組（目前已在群組「${currentGroup.id}」內）`);
        continue;
      }
      const header = raw.slice(0, -1).trim();
      const colon = firstColonOutsideCode(header);
      const id = (colon >= 0 ? header.slice(0, colon) : header).trim();
      const label = colon >= 0 ? unquote(header.slice(colon + 1)) : id;
      if (!id || /[\s{}]/.test(id)) {
        errors.push(`第 ${lineIndex + 1} 行群組識別字「${id || header}」格式不合法`);
        continue;
      }
      let group = groups.find(item => item.id === id);
      if (!group) {
        group = { id, label: label || id, nodes: [] };
        groups.push(group);
      } else if (label) {
        group.label = label;
      }
      currentGroup = group;
      continue;
    }

    // Edge declaration: contains `->`, `<-`, `<->`, or `--` outside inline code
    ARROW_RE.lastIndex = 0;
    if (ARROW_RE.test(masked)) {
      ARROW_RE.lastIndex = 0;
      const tokens: string[] = [];
      const ops: string[] = [];
      let last = 0;
      for (const match of masked.matchAll(ARROW_RE)) {
        tokens.push(raw.slice(last, match.index).trim());
        ops.push(match[1]);
        last = match.index + match[0].length;
      }
      let tail = raw.slice(last).trim();
      let edgeLabel: string | undefined;
      const tailColon = firstColonOutsideCode(tail);
      if (tailColon >= 0) {
        edgeLabel = unquote(tail.slice(tailColon + 1));
        tail = tail.slice(0, tailColon).trim();
      }
      tokens.push(tail);
      if (tokens.some(token => !token)) {
        errors.push(`第 ${lineIndex + 1} 行連線端點不可為空`);
        continue;
      }
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const a = tokens[i];
        const b = tokens[i + 1];
        const label = i === ops.length - 1 && edgeLabel ? edgeLabel : undefined;
        if (op === "<-") rawEdges.push({ from: b, to: a, label, scope: currentGroup?.id });
        else rawEdges.push({ from: a, to: b, label, bidirectional: op === "<->", scope: currentGroup?.id });
      }
      continue;
    }

    // Style/attribute lines like `style.fill: ...` — ignore gracefully if pasted from external D2
    if (/^(style|shape|icon|near|width|height)(\.[a-zA-Z0-9_-]+)?\s*:/.test(raw)) continue;

    // Node declaration: `id: Label` or bare `id`
    const colon = firstColonOutsideCode(raw);
    const localId = (colon >= 0 ? raw.slice(0, colon) : raw).trim();
    const label = colon >= 0 ? raw.slice(colon + 1).trim() : undefined;
    if (!localId || /[\s{}]/.test(localId)) {
      errors.push(`第 ${lineIndex + 1} 行節點識別字「${localId || raw}」不可含空白`);
      continue;
    }
    const fullId = currentGroup ? `${currentGroup.id}.${localId}` : localId;
    ensureNode(fullId, label, currentGroup);
  }

  if (currentGroup) errors.push(`群組「${currentGroup.id}」缺少結尾的 \`}\``);

  const allDeclared = () => [...groups.flatMap(group => group.nodes), ...standalone];
  const resolveRef = (ref: string, scope?: string): string | undefined => {
    if (nodeMap.has(ref)) return ref;
    if (scope && nodeMap.has(`${scope}.${ref}`)) return `${scope}.${ref}`;
    const byLocal = allDeclared().filter(node => node.localId === ref);
    if (byLocal.length === 1) return byLocal[0].id;
    const group = groups.find(item => item.id === ref);
    if (group) {
      errors.push(`連線端點「${ref}」是群組名稱；請指向群組內的節點（例如 ${group.nodes[0]?.id ?? `${ref}.node`}）`);
      return group.nodes[0]?.id;
    }
    // D2 allows implicit standalone nodes declared directly in `a -> b`
    return ensureNode(ref).id;
  };

  const edges: D2Edge[] = [];
  for (const edge of rawEdges) {
    const from = resolveRef(edge.from, edge.scope);
    const to = resolveRef(edge.to, edge.scope);
    if (from && to) {
      edges.push({
        from,
        to,
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.bidirectional ? { bidirectional: true } : {}),
      });
    }
  }

  for (const group of groups) {
    if (group.nodes.length === 0) errors.push(`群組「${group.id}」內至少要有 1 個節點`);
  }

  const allNodes = allDeclared();
  return { direction, groups, nodes: standalone, allNodes, edges, errors };
}
