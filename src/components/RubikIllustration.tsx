import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Box, ChevronDown, Compass, Expand, GitBranch, Pause, Play, RotateCcw, Undo2, X } from 'lucide-react';
import type { RubikIllustrationSpec } from '../../shared/types';
import { applyMove, applyMoves, CORNER_POSITIONS, FACE_NORMALS, inverseMove, isCornerAffected, rankCubeState, rotateVector, serializeCubeInput, solvedCube, stickersAt, type CubeFace, type CubeMove, type CubeState, type StickerFace, type Vector3 } from '../../shared/rubik';
import './rubik-illustration.css';

type View = 'space' | 'moves' | 'search';
interface Turn { move: CubeMove; progress: number }
const COLORS: Record<StickerFace, string> = { U: '#f4f0df', D: '#f4c851', F: '#37c6a4', B: '#658bf1', R: '#fb806b', L: '#f3ab61' };
const FACE_NAMES: Record<CubeFace, string> = { R: '右面', B: '背面', D: '底面' };
const VIEWS = [{ id: 'space', label: '看懂空間', icon: Box }, { id: 'moves', label: '動手旋轉', icon: Compass }, { id: 'search', label: '找到回家路', icon: GitBranch }] as const;
const SEARCH_PATHS: readonly (readonly CubeMove[])[] = [[], ['R'], ['B'], ['D'], ['D', 'R']];
const SEARCH_NODES = SEARCH_PATHS.map(path => ({ path, rank: rankCubeState(applyMoves(solvedCube(), path)) }));
const SEARCH_POINTS = [[240, 37], [78, 139], [240, 139], [402, 139], [402, 245]];
const PLUS = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const TIMES = (a: Vector3, n: number): Vector3 => [a[0] * n, a[1] * n, a[2] * n];

function CubeDrawing({ cube, turn, selected, highlight, yaw, onSelect }: { cube: CubeState; turn: Turn | null; selected: number; highlight: CubeMove | null; yaw: number; onSelect: (cubie: number) => void }) {
  const uid = useId().replace(/:/g, '');
  const facets = useMemo(() => {
    const angle = yaw * Math.PI / 180, pitch = 24 * Math.PI / 180;
    function camera([x, y, z]: Vector3) {
      const rx = x * Math.cos(angle) + z * Math.sin(angle), rz = -x * Math.sin(angle) + z * Math.cos(angle);
      return { x: 240 + rx * 52, y: 170 - (y * Math.cos(pitch) - rz * Math.sin(pitch)) * 52, depth: y * Math.sin(pitch) + rz * Math.cos(pitch) };
    }
    return CORNER_POSITIONS.flatMap((center, position) => {
      const cubie = cube.permutation[position], stickers = stickersAt(cube, position);
      const moving = turn && isCornerAffected(position, turn.move);
      const transform = (v: Vector3) => moving ? rotateVector(v, turn.move, turn.progress) : v;
      return (Object.entries(FACE_NORMALS) as [StickerFace, Vector3][]).flatMap(([face, normal]) => {
        if (camera(transform(normal)).depth < .025) return [];
        const u: Vector3 = normal[0] ? [0, 0, 1] : [1, 0, 0];
        const v: Vector3 = normal[1] ? [0, 0, 1] : [0, 1, 0];
        function polygon(size: number, offset: number) {
          return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
            const point = camera(transform(PLUS(PLUS(center, TIMES(normal, offset)), PLUS(TIMES(u, sx * size), TIMES(v, sy * size)))));
            return `${point.x},${point.y}`;
          }).join(' ');
        }
        const midpoint = camera(transform(PLUS(center, TIMES(normal, .93))));
        const sticker = stickers.find(item => item.currentFace === face);
        return [{ key: `${position}-${face}`, cubie, face, body: polygon(.94, .94), sticker: polygon(.78, .955), midpoint,
          color: sticker ? COLORS[sticker.homeFace] : null, selected: cubie === selected,
          affected: !!highlight && isCornerAffected(position, highlight), dimmed: !!highlight && !isCornerAffected(position, highlight) }];
      });
    }).sort((a, b) => a.midpoint.depth - b.midpoint.depth);
  }, [cube, turn, selected, highlight, yaw]);
  return <svg className="rb-cube" viewBox="0 0 480 350" role="img" aria-label={`2×2 魔方，${turn ? `正在轉動 ${turn.move}` : `狀態編號 ${rankCubeState(cube)}`}；角塊 0 固定。可使用下方位置按鈕選取角塊。`}>
    <defs>
      <radialGradient id={`${uid}-halo`}><stop offset="0" stopColor="#cad7ff" stopOpacity=".55"/><stop offset="1" stopColor="#edf2fc" stopOpacity="0"/></radialGradient>
      <radialGradient id={`${uid}-shadow`}><stop offset="0" stopColor="#30466f" stopOpacity=".2"/><stop offset="1" stopColor="#30466f" stopOpacity="0"/></radialGradient>
      <pattern id={`${uid}-grid`} width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".85" fill="#bdc9dc" opacity=".45"/></pattern>
    </defs>
    <rect width="480" height="350" fill={`url(#${uid}-grid)`}/><ellipse cx="250" cy="170" rx="230" ry="174" fill={`url(#${uid}-halo)`}/><ellipse cx="246" cy="305" rx="156" ry="25" fill={`url(#${uid}-shadow)`}/>
    <g aria-hidden="true">{facets.map(facet => <g key={facet.key} style={facet.dimmed ? { filter: 'saturate(.3) brightness(1.1)' } : undefined} className="rb-facet" onClick={() => onSelect(facet.cubie)}>
      <polygon points={facet.body} fill="#253247" stroke="#34445d" strokeWidth="1.5" strokeLinejoin="round"/>
      {facet.color && <><polygon points={facet.sticker} fill={facet.color} stroke={facet.selected ? '#fff' : facet.affected ? '#deedff' : '#ffffff50'} strokeWidth={facet.selected ? 3.2 : facet.affected ? 2.5 : 1} strokeLinejoin="round"/>
        <circle cx={facet.midpoint.x} cy={facet.midpoint.y} r="12" fill="#15263b" fillOpacity={facet.selected ? .84 : .6}/>
        <text x={facet.midpoint.x} y={facet.midpoint.y + 4.7} textAnchor="middle" fill="white" fontSize="14" fontWeight="650">{facet.cubie}</text></>}
    </g>)}</g>
    <g className="rb-axis" aria-hidden="true"><text x="26" y="326">固定座標：+Y 上</text><text x="26" y="343">+X 右 · +Z 前（初始視角）</text><text x="452" y="326" textAnchor="end">數字 = 角塊身分</text><text x="452" y="343" textAnchor="end">0 是固定參照</text></g>
  </svg>;
}

export default function RubikIllustration({ data, sectionIndex }: { data: RubikIllustrationSpec; sectionIndex: number }) {
  const uid = useId().replace(/:/g, '');
  const focus = data.focus?.find(item => item.sectionIndex === sectionIndex)?.view;
  const [view, setView] = useState<View>(() => focus ?? 'space');
  const [cube, setCube] = useState<CubeState>(() => focus === 'moves' ? applyMoves(solvedCube(), data.setupMoves) : solvedCube());
  const [history, setHistory] = useState<CubeMove[]>(() => focus === 'moves' ? [...data.setupMoves] : []);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [queue, setQueue] = useState<CubeMove[]>([]);
  const [selected, setSelected] = useState(0);
  const [hoverMove, setHoverMove] = useState<CubeMove | null>(null);
  const [yaw, setYaw] = useState(-32);
  const [layer, setLayer] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false);
  const [announcement, setAnnouncement] = useState('選一個角塊，觀察它的位置與顏色。');
  const dialog = useRef<HTMLDialogElement>(null), expandButton = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(false);
  const busy = !!turn || queue.length > 0;
  const rank = rankCubeState(cube), input = serializeCubeInput(cube);
  const selectedPosition = cube.permutation.indexOf(selected);
  const setupKey = data.setupMoves.join(' ');

  function load(moves: readonly CubeMove[], message = '已載入狀態。') {
    setQueue([]); setTurn(null); setCube(applyMoves(solvedCube(), moves)); setHistory([...moves]); setHoverMove(null); setAnnouncement(message);
  }
  function chooseView(next: View) {
    setView(next); load(next === 'moves' ? data.setupMoves : [], next === 'moves' ? '已載入文中範例，可以繼續轉動或沿原路還原。' : '從已解狀態開始探索。');
  }
  useEffect(() => {
    if (focus) {
      setView(focus); setQueue([]); setTurn(null); setHoverMove(null);
      const moves = focus === 'moves' ? data.setupMoves : [];
      setCube(applyMoves(solvedCube(), moves)); setHistory([...moves]);
      setAnnouncement('圖解已跟隨閱讀段落切換。');
    }
  // A note refresh must not reset an interactive exploration; only section/preset changes do.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionIndex, focus, setupKey]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReducedMotion(media.matches); if (media.matches) setQueue([]); };
    media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  const move = turn?.move;
  useEffect(() => {
    if (!move) return;
    let frame = 0, start: number | null = null;
    function finish() {
      setCube(current => applyMove(current, move!)); setHistory(current => [...current, move!]); setTurn(null);
      setAnnouncement(`完成 ${move}，角塊 0 保持固定。`);
    }
    if (reducedMotion) { finish(); return; }
    function animate(time: number) {
      start ??= time;
      const elapsed = Math.min(1, (time - start) / (move!.endsWith('2') ? 1000 : 780));
      const progress = elapsed * elapsed * (3 - 2 * elapsed);
      if (elapsed >= 1) finish();
      else { setTurn({ move: move!, progress }); frame = requestAnimationFrame(animate); }
    }
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame);
  }, [move, reducedMotion]);
  useEffect(() => {
    if (turn || !queue.length) return;
    const timer = window.setTimeout(() => { setTurn({ move: queue[0], progress: 0 }); setQueue(items => items.slice(1)); }, 400);
    return () => window.clearTimeout(timer);
  }, [turn, queue]);
  useEffect(() => {
    if (!busy && rank === 0 && history.length) setHistory([]);
  }, [busy, rank, history.length]);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (previousExpanded.current) expandButton.current?.focus();
    previousExpanded.current = expanded;
  }, [expanded]);
  function demo() {
    setView('moves');
    if (reducedMotion) {
      if (rank === SEARCH_NODES[3].rank) stepMove("D'");
      else { load([]); setTurn({ move: 'D', progress: 0 }); }
    } else { load([]); setQueue(['D', "D'"]); }
  }
  function restore() {
    const path = [...history].reverse().map(inverseMove);
    if (reducedMotion) {
      setCube(applyMoves(cube, path)); setHistory([]); setQueue([]);
      setAnnouncement('已沿原路還原；依系統偏好省略轉動動畫。');
    } else setQueue(path);
  }
  function stepMove(next: CubeMove) { if (!busy) { setHoverMove(null); setTurn({ move: next, progress: 0 }); } }
  const narrative = view === 'space'
    ? { eyebrow: '01 / 先給抽象編號一個位置', title: '位置是座位，角塊是乘客。', body: '魔方轉動時，座位編號不變，帶著三種顏色的角塊會換座位、改朝向。先點下方格子，找到同一顆角塊。' }
    : view === 'moves'
      ? { eyebrow: '02 / 把一行程式變成一次轉動', title: '轉一個面，四個角塊一起搬家。', body: 'R 是右面、B 是背面、D 是底面。試著轉動：圖形、位置陣列與查表編號會同步改變。加上 ′ 表示反轉，2 表示半圈。' }
      : { eyebrow: '03 / 從答案出發，留下回程路標', title: 'BFS 一圈一圈，找到最短的回家路。', body: '從已解狀態向外探索。每發現一個新狀態，就存下「怎麼回到上一層」。查表時沿著這些逆操作，便能回到答案。' };

  const content = <section className={`rb-card${expanded ? ' rb-expanded' : ''}`} aria-label={data.title} data-view={view} data-rank={rank} data-animating={!!turn}>
    <header className="rb-header"><span><i/>空間互動圖解</span><button type="button" ref={expanded ? undefined : expandButton} onClick={() => setExpanded(value => !value)} aria-label={expanded ? '關閉魔方放大檢視' : '放大魔方圖解'} title={expanded ? '關閉' : '放大圖解'}>{expanded ? <X size={17}/> : <Expand size={16}/>}</button></header>
    <h3 className="rb-title">{data.title}</h3>
    <div className="rb-tabs" role="group" aria-label="魔方圖解視角">{VIEWS.map(item => <button type="button" key={item.id} aria-pressed={view === item.id} onClick={() => chooseView(item.id)}><item.icon size={15}/>{item.label}</button>)}</div>
    <div className="rb-narrative"><span>{narrative.eyebrow}</span><h4>{narrative.title}</h4><p>{narrative.body}</p></div>
    <div className="rb-workspace"><div className="rb-spatial-pane">
      <div className="rb-stage">
        <div className="rb-stage-status"><span className={rank === 0 && !turn ? 'rb-solved' : ''}><i/>{turn ? `正在轉 ${turn.move}` : rank === 0 ? '已解狀態' : '探索中的狀態'}</span><b>2 × 2 × 2</b></div>
        <CubeDrawing cube={cube} turn={turn} selected={selected} highlight={turn?.move || hoverMove} yaw={yaw} onSelect={setSelected}/>
        <div className="rb-camera"><span>查看另一面</span><button type="button" onClick={() => setYaw(value => value - 90)} aria-label="向左轉動魔方視角"><ArrowLeft size={14}/></button><button type="button" onClick={() => setYaw(-32)} aria-label="回到正面視角">正面</button><button type="button" onClick={() => setYaw(value => value + 90)} aria-label="向右轉動魔方視角"><ArrowRight size={14}/></button></div>
      </div>
      <div className="rb-selected"><span className="rb-cubie-number">{selected}</span><div><b>角塊 {selected}{selected === 0 ? ' · 固定參照' : ` · 現在坐在位置 ${selectedPosition}`}</b><p>{selected === 0 ? 'R、B、D 都不會移動它，因此可以省略這個角塊的輸入。' : `這顆角塊的朝向值為 ${cube.orientations[selectedPosition]}；旋轉時追蹤它的三片顏色。`}</p></div></div>
      <div className="rb-map-header"><b>位置對照</b><span>格子是位置 · 大數字是角塊</span></div>
      <div className="rb-position-maps">{[{ name: '前層', positions: [0, 1, 3, 2] }, { name: '背層 · 從前方穿透看', positions: [7, 4, 6, 5] }].map(group => <div key={group.name}><span>{group.name}</span><div className="rb-position-grid">{group.positions.map(position => <button type="button" key={position} className={cube.permutation[position] === selected ? 'rb-position-selected' : ''} aria-pressed={cube.permutation[position] === selected} aria-label={`位置 ${position}，角塊 ${cube.permutation[position]}，朝向 ${cube.orientations[position]}`} onClick={() => setSelected(cube.permutation[position])}><small>位置 {position}</small><b>{cube.permutation[position]}</b><i style={{ background: COLORS[stickersAt(cube, position).find(item => item.currentFace === (position === 0 || position === 1 || position === 2 || position === 3 ? 'F' : 'B'))!.homeFace] }}/></button>)}</div></div>)}</div>
    </div><div className="rb-explanation-pane">
      {view === 'space' && <div className="rb-space-lesson"><div><span>排列 permutation</span><p>哪顆角塊坐在哪個位置？就像一張換過座位的座位表。</p></div><div><span>朝向 orientation</span><p>角塊沒有變形，只是轉了方向。同一顆角塊仍然帶著原本的三種顏色。</p></div><button type="button" className="rb-primary" onClick={() => chooseView('moves')}>下一步，親手轉一次 <ArrowRight size={15}/></button></div>}
      {view === 'moves' && <div className="rb-move-panel"><div className="rb-panel-heading"><b>選一個面，觀察四個角塊</b><span>由該面外側看轉向</span></div>
        {(['R', 'B', 'D'] as const).map(face => <div className="rb-move-row" key={face}><span><b>{face}</b>{FACE_NAMES[face]}</span>{(['', "'", '2'] as const).map(suffix => { const next = `${face}${suffix}` as CubeMove; return <button type="button" key={next} disabled={busy} onMouseEnter={() => setHoverMove(next)} onMouseLeave={() => setHoverMove(null)} onFocus={() => setHoverMove(next)} onBlur={() => setHoverMove(null)} onClick={() => stepMove(next)} aria-label={`${next}：${FACE_NAMES[face]}${suffix === "'" ? '逆時針 90 度' : suffix === '2' ? '旋轉 180 度' : '順時針 90 度'}`}><b>{next.replace("'", '′')}</b><small>{suffix === "'" ? '逆轉 90°' : suffix === '2' ? '半圈 180°' : '順轉 90°'}</small></button>; })}</div>)}
        <div className="rb-actions"><button type="button" disabled={busy} onClick={() => load(data.setupMoves, '已重新載入文中案例。')}>載入文中案例</button><button type="button" onClick={() => load([], '已重設為已解狀態。')}><RotateCcw size={13}/>重設</button></div>
        <div className="rb-demo"><p><b>30 秒看懂逆操作</b><span>D 先轉底面，再用 D′ 沿原路回來。</span></p><button type="button" className="rb-primary" disabled={busy && !queue.length} onClick={queue.length ? () => setQueue([]) : demo}>{queue.length ? <Pause size={14}/> : <Play size={14}/>} {queue.length ? '停止連播' : reducedMotion ? `示範下一步 ${rank === SEARCH_NODES[3].rank ? 'D′' : 'D'}` : '示範 D → D′'}</button></div>
      </div>}
      {view === 'search' && <div className="rb-search-panel"><div className="rb-panel-heading"><b>從第 0 層向外展開</b><button type="button" disabled={busy} onClick={() => setLayer(value => (value + 1) % 3)}> {layer === 2 ? '收回第 0 層' : `展開第 ${layer + 1} 層`} <ArrowRight size={13}/></button></div>
        <svg className="rb-search" viewBox="0 0 480 308" role="group" aria-label="BFS 狀態鄰居示意圖，點選節點可在立體圖中檢視">
          <defs><marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#77a397" strokeWidth="1.5"/></marker></defs>
          {[37, 139, 245].map((y, depth) => <g key={depth} opacity={depth <= layer ? 1 : .3}><line x1="15" x2="465" y1={y + 29} y2={y + 29} stroke="#dce5ee" strokeDasharray="3 5"/><text x="16" y={y + 47} className="rb-layer-label">第 {depth} 層</text></g>)}
          {SEARCH_NODES.slice(1).map((node, index) => { const depth = node.path.length; if (depth > layer) return null; const [x, y] = SEARCH_POINTS[index + 1], [px, py] = SEARCH_POINTS[depth === 1 ? 0 : 3]; return <g key={node.rank}><path d={`M ${x} ${y - 29} Q ${x} ${(py + y) / 2} ${px} ${py + 31}`} fill="none" stroke="#77a397" strokeWidth="2" markerEnd={`url(#${uid}-arrow)`}/><text x={(x + px) / 2 + (x < px ? -16 : 16)} y={(y + py) / 2 + 5} textAnchor="middle" className="rb-inverse-label">{inverseMove(node.path.at(-1)!).replace("'", '′')}</text></g>; })}
          {SEARCH_NODES.map((node, index) => { if (node.path.length > layer) return null; const [x, y] = SEARCH_POINTS[index]; return <g key={node.rank} transform={`translate(${x},${y})`} className={`rb-search-node${rank === node.rank ? ' rb-search-active' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-pressed={rank === node.rank} aria-label={`${node.path.length === 0 ? '已解狀態' : node.path.join(' → ')}，狀態編號 ${node.rank}`} onClick={() => { if (!busy) load(node.path, `顯示狀態 ${node.rank}。`); }} onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); load(node.path, `顯示狀態 ${node.rank}。`); } }}><rect x="-58" y="-26" width="116" height="52" rx="12"/><text y="-4" textAnchor="middle">{node.path.length ? node.path.join(' → ') : '已解狀態'}</text><text y="15" textAnchor="middle" className="rb-rank-label">#{node.rank.toLocaleString('en-US')}</text></g>; })}
        </svg>
        <p className="rb-search-hint"><i/>箭頭指向上一層，標籤是存進表裡的逆操作。</p><p className="rb-fineprint">只選出九個一步鄰居中的 R、B、D，以及一個兩步狀態示意；不是完整搜尋樹。</p>
        <div className="rb-code-explain"><span>當你從狀態 0 走 D，找到 144342</span><code>table[144342] = D′</code><p>記住「回去要走 D′」，查表時就不必重新搜尋。</p></div>
      </div>}
      <div className="rb-state-panel"><div className="rb-panel-heading"><b>這個圖，在程式裡長這樣</b><span>{turn ? '轉完後更新' : '同步計算'}</span></div><div className="rb-input"><span>輸入字串</span><code><b>{input.slice(0, 7)}</b><em>{input.slice(7)}</em></code><div><span>前 7 位：角塊</span><span>後 7 位：朝向（1–3）</span></div></div><div className="rb-rank"><span>rank_state <ArrowRight size={12}/></span><strong>{rank.toLocaleString('en-US')}</strong><small>唯一地址，不是剩餘步數</small></div>
        <details className="rb-arrays"><summary>對照 C 陣列 p 與 o <ChevronDown size={13}/></summary><code>p = [{cube.permutation.slice(1).map(id => id - 1).join(', ')}]<br/>o = [{cube.orientations.slice(1).join(', ')}]</code><p>C 陣列略過固定角塊 0；角塊與輸入朝向都減 1，成為從 0 開始的編號。</p></details>
      </div>
      <div className="rb-path"><div><span>從已解狀態走過的路</span><code>{history.length ? history.slice(-12).map(item => item.replace("'", '′')).join(' → ') : '起點 · 0'}{history.length > 12 && '（最近 12 步）'}</code></div>{queue.length > 0 ? <button type="button" onClick={() => setQueue([])}><Pause size={14}/>停止播放</button> : <button type="button" disabled={busy || !history.length || rank === 0} onClick={restore}><Undo2 size={14}/>沿路還原</button>}</div>
      <p className="rb-live" role="status">{announcement}</p>
    </div></div>
    <details className="rb-method"><summary>圖解依據與範圍 <ChevronDown size={14}/></summary><p>{data.caption}</p><p>顏色是視覺輔助；狀態與旋轉依固定參照的 2×2 角塊模型計算。「沿路還原」反轉你剛走過的路，不會即時執行完整 BFS。</p></details>
  </section>;
  return expanded ? createPortal(<dialog ref={dialog} className="rb-dialog" aria-label="魔方互動工作室" onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }}>{content}</dialog>, document.body) : content;
}
