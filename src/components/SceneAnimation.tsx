import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Circle, Layers3, Maximize2, Minimize2, MousePointer2, Pause, Play, RotateCcw, ScanEye, Terminal, Waypoints, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Visual, VisualNode, VisualScene, VisualStep } from '../../shared/types';
import MathText, { ProseBlocks } from './MathText';
import './scene-animation.css';

interface Props { visual:Visual; step:number; onStepChange:(step:number)=>void; compact?:boolean; /** Hide what a step changes until the learner reveals it. */ predict?:boolean; }
interface Box { x:number; y:number; width:number; height:number; }
interface Drawing { width:number; height:number; boxes:Map<string,Box>; }
type Edge=VisualScene['edges'][number];
type NodeState=NonNullable<VisualStep['nodeStates']>[number];
const layoutLabels:Record<VisualScene['layout'],string>={flow:'資料與控制流',sequence:'互動時序',memory:'記憶體與參照',layers:'分層架構',timeline:'事件歷程'};
const edgeLabels:Record<Edge['type'],string>={data:'資料',reference:'參照',call:'呼叫',return:'回傳',control:'控制'};
const groupColors=['#6584d6','#9881c6','#4f9a9b','#ba9367','#bf7d9a','#809365'];
const emptyScene:VisualScene={layout:'flow',edges:[],groups:[]};
function short(text:string,limit:number){
  let count=0,result='';
  for(const char of text){count+=char.charCodeAt(0)>255?1.7:1;if(count>limit)return `${result}…`;result+=char;}
  return result;
}
function stateValue(state:NodeState|undefined){return state?state.value===''?'""':state.value:'此步未標示狀態';}
function tokenChanges(previous:NodeState|undefined,current:NodeState|undefined){
  if(!previous||!current)return {added:0,removed:0};
  const count=(items:string[])=>{const result=new Map<string,number>();for(const item of items)result.set(item,(result.get(item)||0)+1);return result;};
  const before=count(previous.items),after=count(current.items);
  let added=0,removed=0;
  for(const [item,total] of after)added+=Math.max(0,total-(before.get(item)||0));
  for(const [item,total] of before)removed+=Math.max(0,total-(after.get(item)||0));
  return {added,removed};
}
function drawingFor(nodes:VisualNode[],scene:VisualScene,activeEdges:Edge[],narrow:boolean):Drawing{
  const boxes=new Map<string,Box>();
  if(scene.layout==='sequence'){
    const width=Math.max(600,nodes.length*205+44);
    nodes.forEach((node,index)=>boxes.set(node.id,{x:28+index*(width-56)/nodes.length+((width-56)/nodes.length-178)/2,y:36,width:178,height:154}));
    return {width,height:Math.max(350,250+activeEdges.length*58),boxes};
  }
  if(scene.layout==='layers'){
    const used=new Set<string>();const rows:Array<VisualNode[]>=[];
    for(const group of scene.groups){
      const members=nodes.filter(node=>group.nodeIds.includes(node.id)&&!used.has(node.id));
      for(const node of members)used.add(node.id);
      for(let index=0;index<members.length;index+=narrow?1:2)rows.push(members.slice(index,index+(narrow?1:2)));
    }
    const remaining=nodes.filter(node=>!used.has(node.id));
    for(let index=0;index<remaining.length;index+=narrow?1:2)rows.push(remaining.slice(index,index+(narrow?1:2)));
    rows.forEach((row,index)=>row.forEach((node,column)=>boxes.set(node.id,{x:narrow?55:row.length===1?185:36+column*316,y:38+index*208,width:270,height:168})));
    return {width:narrow?380:640,height:Math.max(270,rows.length*208+42),boxes};
  }
  const columns=narrow||nodes.length===1?1:2;
  const ordered=scene.layout==='memory'?[...nodes].sort((a,b)=>{
    const groupA=scene.groups.findIndex(group=>group.nodeIds.includes(a.id));
    const groupB=scene.groups.findIndex(group=>group.nodeIds.includes(b.id));
    return (groupA<0?99:groupA)-(groupB<0?99:groupB);
  }):nodes;
  ordered.forEach((node,index)=>boxes.set(node.id,{x:narrow?55:columns===1?185:36+(index%2)*316,y:38+Math.floor(index/columns)*222,width:270,height:168}));
  return {width:narrow?380:640,height:Math.max(270,Math.ceil(nodes.length/columns)*222+34),boxes};
}
function graphPath(from:Box,to:Box,bend:number){
  const ax=from.x+from.width/2,ay=from.y+from.height/2,bx=to.x+to.width/2,by=to.y+to.height/2;
  if(Math.abs(ay-by)<12){
    const direction=Math.sign(bx-ax)||1;
    const sx=ax+direction*(from.width/2+3),ex=bx-direction*(to.width/2+9),y=ay+bend*11;
    return {path:`M ${sx} ${y} C ${(sx+ex)/2} ${y-16*bend}, ${(sx+ex)/2} ${y-16*bend}, ${ex} ${y}`,x:(sx+ex)/2,y:y-12-8*bend};
  }
  if(Math.abs(ax-bx)<12){
    if(Math.abs(ay-by)>from.height+100){
      const rail=Math.min(from.x,to.x)-24-Math.abs(bend)*10;
      return {path:`M ${from.x-3} ${ay} H ${rail+10} Q ${rail} ${ay} ${rail} ${ay+Math.sign(by-ay)*10} V ${by-Math.sign(by-ay)*10} Q ${rail} ${by} ${rail+10} ${by} H ${to.x-9}`,x:rail+15,y:(ay+by)/2};
    }
    const direction=Math.sign(by-ay)||1;
    const sy=ay+direction*(from.height/2+3),ey=by-direction*(to.height/2+9),x=ax+bend*34;
    return {path:`M ${x} ${sy} C ${x+20*bend} ${(sy+ey)/2}, ${x+20*bend} ${(sy+ey)/2}, ${x} ${ey}`,x:x+13+12*bend,y:(sy+ey)/2};
  }
  const direction=Math.sign(bx-ax)||1;
  const sx=ax+direction*(from.width/2+3),ex=bx-direction*(to.width/2+9),mid=(sx+ex)/2+bend*10;
  return {path:`M ${sx} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${ex} ${by}`,x:mid+12,y:(ay+by)/2-8};
}
/**
 * A state is new in this step when it differs from the previous step or did not exist there.
 * The first step has nothing before it: its states are the starting point, not changes.
 */
const stateChanged=(state:NodeState|undefined,previous:NodeState|undefined,firstStep:boolean)=>!firstStep&&!!state&&(!previous||state.value!==previous.value||JSON.stringify(state.items)!==JSON.stringify(previous.items));
function SceneNode({node,box,index,state,previous,active,selected,groups,onSelect,masked,firstStep}:{node:VisualNode;box:Box;index:number;state?:NodeState;previous?:NodeState;active:boolean;selected:boolean;groups:VisualScene['groups'];onSelect:()=>void;masked:boolean;firstStep:boolean}){
  // While masked, every value in the step is hidden and nothing marks which ones changed:
  // which states change is part of what the learner predicts.
  const hidden=masked&&!!state;
  const changed=!masked&&stateChanged(state,previous,firstStep);
  const changes=tokenChanges(previous,state);
  const memberships=groups.filter(group=>group.nodeIds.includes(node.id));
  const maxItems=box.width<200?2:3;
  const visible=state?.items.slice(0,maxItems)||[];
  return <g transform={`translate(${box.x},${box.y})`} className={`sa-node${active?' sa-node-active':''}${selected?' sa-node-selected':''}${changed?' sa-node-changed':''}`} data-node-id={node.id} role="button" tabIndex={0} aria-label={`檢視 ${node.label}，${hidden?'本步狀態已隱藏，先預測再揭曉':`${stateValue(state)}${changed?'；本步狀態已更新':''}`}`} aria-pressed={selected} onClick={onSelect} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect();}}}>
    <title>{`${node.label}\n${node.detail}\n當前狀態：${hidden?'先預測，再揭曉':`${stateValue(state)}${state?.items.length?`\n${state.items.join('\n')}`:''}`}`}</title>
    <rect className="sa-node-aura" x="-5" y="-5" width={box.width+10} height={box.height+10} rx="21"/>
    <rect className="sa-node-face" width={box.width} height={box.height} rx="16"/>
    <rect className="sa-node-header-fill" x="1" y="1" width={box.width-2} height="42" rx="15"/>
    <circle className="sa-node-light" cx="16" cy="22" r="3.5"/>
    <text className="sa-node-heading" x="27" y="28">{short(node.label,box.width<200?14:21)}</text>
    <text className="sa-node-number" x={box.width-15} y="27" textAnchor="end">{String(index+1).padStart(2,'0')}</text>
    <line className="sa-node-rule" x1="15" x2={box.width-15} y1="44" y2="44"/>
    <text className="sa-node-detail" x="16" y="65">{short(node.detail,box.width<200?18:30)}</text>
    <g key={`${node.id}:${state?.value??'unknown'}`} className={changed?'sa-value-changed':''}>
      <rect className={`sa-value-bg${state?'':' sa-value-unknown'}`} x="13" y="77" width={box.width-26} height="31" rx="7"/>
      <text className={`sa-node-value${state?'':' sa-node-value-unknown'}${hidden?' sa-node-value-hidden':''}`} x="23" y="98">{hidden?'？ 先預測':short(stateValue(state),box.width<200?17:27)}</text>
      {changed&&<circle className="sa-change-dot" cx={box.width-25} cy="92" r="3"/>}
    </g>
    {hidden?<text className="sa-node-footnote" x="16" y="134">這一步會變成什麼？</text>:visible.length>0?<g className="sa-tokens">{visible.map((item,itemIndex)=>{
      const width=(box.width-34)/maxItems;
      const occurrence=state!.items.slice(0,itemIndex+1).filter(value=>value===item).length;
      const added=!!previous&&previous.items.filter(value=>value===item).length<occurrence;
      return <g key={`${item}:${occurrence}`} transform={`translate(${15+itemIndex*(width+2)},119)`}><g className={added?'sa-token-added':''}><rect className={`sa-token${added?' sa-token-new':''}`} width={width-3} height="23" rx="5"/><text className="sa-token-text" x={(width-3)/2} y="16" textAnchor="middle">{short(item,box.width<200?10:9)}</text></g></g>;
    })}{state!.items.length>maxItems&&<text className="sa-items-more" x={box.width-15} y={box.height-10} textAnchor="end">另有 {state!.items.length-maxItems} 項</text>}</g>:<text className="sa-node-footnote" x="16" y="134">{memberships.length?short(memberships.map(group=>group.label).join(' / '),box.width<200?20:33):state?'本步提供的狀態':'點擊檢視節點說明'}</text>}
    {changed&&!hidden&&box.height>155&&<text className="sa-node-delta" x="16" y={box.height-10}>狀態已更新{changes.added?` ＋${changes.added}`:''}{changes.removed?` −${changes.removed}`:''}</text>}
  </g>;
}

export default function SceneAnimation({visual,step,onStepChange,compact=false,predict=false}:Props){
  const scene=visual.scene||emptyScene;
  const id=useId().replace(/[^a-zA-Z0-9_-]/g,'');
  const [playing,setPlaying]=useState(false);
  const [speed,setSpeed]=useState(1);
  const [zoom,setZoom]=useState(false);
  const [stageWidth,setStageWidth]=useState(640);
  const stageRef=useRef<HTMLDivElement>(null);
  const [expanded,setExpanded]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const expandButton=useRef<HTMLButtonElement>(null);
  const wasExpanded=useRef(false);
  const [inspecting,setInspecting]=useState(false);
  const [selectedId,setSelectedId]=useState(visual.nodes[0]?.id||'');
  const [reducedMotion,setReducedMotion]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const callback=useRef(onStepChange);callback.current=onStepChange;
  const total=visual.steps.length;
  const currentStep=Math.max(0,Math.min(Number.isFinite(step)?Math.floor(step):0,Math.max(total-1,0)));
  const current=visual.steps[currentStep];
  const previous=visual.steps[currentStep-1];
  const currentStates=new Map(current?.nodeStates?.map(state=>[state.nodeId,state]));
  const previousStates=new Map(previous?.nodeStates?.map(state=>[state.nodeId,state]));
  const activeNodes=new Set(current?.activeNodeIds||[]);
  const activeEdges=new Set(current?.activeEdgeIds||[]);
  const validIds=new Set(visual.nodes.map(node=>node.id));
  const edges=scene.edges.filter(edge=>validIds.has(edge.from)&&validIds.has(edge.to)&&edge.from!==edge.to);
  const sequenceEdges=edges.filter(edge=>activeEdges.has(edge.id));
  const narrow=stageWidth<540&&!zoom;
  const drawing=useMemo(()=>drawingFor(visual.nodes,scene,sequenceEdges,narrow),[visual.nodes,scene,sequenceEdges.length,narrow]);
  const selected=visual.nodes.find(node=>node.id===selectedId)||visual.nodes[0];
  const selectedState=selected?currentStates.get(selected.id):undefined;
  const previousState=selected?previousStates.get(selected.id):undefined;
  const connections=selected?edges.filter(edge=>edge.from===selected.id||edge.to===selected.id):[];
  const selectedGroups=selected?scene.groups.filter(group=>group.nodeIds.includes(selected.id)):[];
  const changedStates=current?.nodeStates?.filter(state=>stateChanged(state,previousStates.get(state.nodeId),currentStep===0))||[];
  const changedNodes=changedStates.length;
  const [revealed,setRevealed]=useState<Set<number>>(()=>new Set());
  // Manual stepping asks for a prediction first; steps shown by playback count as seen.
  const masked=predict&&!playing&&currentStep>0&&!revealed.has(currentStep)&&(changedNodes>0||!!current?.output);
  const reveal=()=>setRevealed(set=>new Set(set).add(currentStep));
  const selectedHidden=masked&&!!selectedState;
  const focusId=(masked?undefined:changedStates[0]?.nodeId)||current?.activeNodeIds[0];
  useEffect(()=>{
    const element=stageRef.current;if(!element)return;
    const observer=new ResizeObserver(entries=>setStageWidth(entries[0].contentRect.width));
    observer.observe(element);return()=>observer.disconnect();
  },[expanded]);
  useEffect(()=>{
    if(focusId)setSelectedId(focusId);
  },[currentStep,focusId,visual]);
  useEffect(()=>{
    const stageElement=stageRef.current;
    if(!narrow||!stageElement)return;
    const nodeElement=[...stageElement.querySelectorAll<SVGGElement>('[data-node-id]')].find(element=>element.dataset.nodeId===focusId);
    if(!nodeElement)return;
    const viewport=stageElement.getBoundingClientRect(),nodeBox=nodeElement.getBoundingClientRect();
    if(nodeBox.top<viewport.top+10||nodeBox.bottom>viewport.bottom-10){
      stageElement.scrollTo({top:stageElement.scrollTop+nodeBox.top-viewport.top-24,behavior:reducedMotion?'auto':'smooth'});
    }
  },[currentStep,focusId,narrow,expanded,visual,reducedMotion,stageWidth]);
  useEffect(()=>{
    if(expanded){if(dialog.current&&!dialog.current.open)dialog.current.showModal();}
    else if(wasExpanded.current)expandButton.current?.focus();
    wasExpanded.current=expanded;
  },[expanded]);
  // Keyed on content: a refreshed copy of the same note (favorite, annotation, sync) keeps what was revealed.
  const contentKey=useMemo(()=>JSON.stringify([visual.nodes,visual.steps,visual.scene]),[visual]);
  useEffect(()=>{setPlaying(false);setSelectedId(visual.steps[currentStep]?.activeNodeIds[0]||visual.nodes[0]?.id||'');setZoom(false);setRevealed(new Set());},[contentKey]);
  useEffect(()=>{if(playing)setRevealed(set=>set.has(currentStep)?set:new Set(set).add(currentStep));},[playing,currentStep]);
  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>{setReducedMotion(media.matches);if(media.matches)setPlaying(false);};
    media.addEventListener('change',update);return()=>media.removeEventListener('change',update);
  },[]);
  useEffect(()=>{
    if(!playing||reducedMotion||total<2)return;
    if(currentStep>=total-1){setPlaying(false);return;}
    const timer=window.setTimeout(()=>callback.current(currentStep+1),2800/speed);
    return()=>window.clearTimeout(timer);
  },[playing,reducedMotion,total,currentStep,speed]);
  function seek(next:number){setPlaying(false);callback.current(Math.max(0,Math.min(next,Math.max(total-1,0))));}
  function play(){
    if(reducedMotion){seek(currentStep>=total-1?0:currentStep+1);return;}
    if(!playing&&currentStep>=total-1)callback.current(0);
    setPlaying(value=>!value);
  }
  function replay(){callback.current(0);setPlaying(total>1&&!reducedMotion);}
  const relatedNodes=visual.nodes.filter(node=>activeNodes.has(node.id));
  const stepRelations=edges.filter(edge=>activeEdges.has(edge.id));
  const edgeTypeList=[...new Set(edges.map(edge=>edge.type))];
  const style={'--sa-duration':`${.48/speed}s`} as CSSProperties;
  const content=<section className={`scene-card${compact&&!expanded?' scene-compact':''}${expanded?' sa-fullscreen-card':''}${playing?' sa-playing':''}${reducedMotion?' sa-reduced':''}`} style={style} aria-label={visual.title} data-step={currentStep} data-layout={scene.layout}>
    <header className="sa-header"><span className="sa-badge"><i/>動態圖解</span><span className="sa-layout-label">{layoutLabels[scene.layout]}</span><span className="sa-count">{String(total?currentStep+1:0).padStart(2,'0')}<i> / {String(total).padStart(2,'0')}</i></span></header>
    <div className="sa-title"><Waypoints size={17}/><h3><MathText text={visual.title}/></h3></div>
    <div className="sa-step-overview" aria-live={playing?'off':'polite'} aria-atomic="true"><span className="sa-step-number">{String(total?currentStep+1:0).padStart(2,'0')}</span><div><span className="sa-eyebrow">這一步發生什麼</span><h4><MathText text={current?.title||'場景總覽'}/></h4>{masked?<div className="sa-predict"><p>先預測：這一步之後，哪些狀態會改變{current?.output?'、會輸出什麼':''}？</p><button type="button" className="sa-reveal" onClick={reveal}>揭曉這一步</button></div>:<ProseBlocks text={current?.description||visual.caption}/>}</div></div>
    <div className="sa-workspace"><div className="sa-canvas-pane">
    {scene.layout==='timeline'&&<div className="sa-event-track" aria-label="教學事件歷程">{visual.steps.map((item,index)=><button type="button" key={index} className={index===currentStep?'sa-event-current':index<currentStep?'sa-event-past':''} aria-current={index===currentStep?'step':undefined} onClick={()=>seek(index)} title={item.title}><span>{index<currentStep?<Check size={11}/>:index+1}</span><b><MathText text={item.title}/></b></button>)}</div>}
    <div className="sa-playback">
      <div className="sa-controls"><button type="button" className="sa-small-button" onClick={replay} disabled={!total} aria-label="重播動畫" title="重播動畫"><RotateCcw size={14}/></button><button type="button" className="sa-play" onClick={play} disabled={total<2} aria-label={reducedMotion?'前進一個步驟':playing?'暫停動畫':'播放動畫'} title={reducedMotion?'使用系統逐步模式':playing?'暫停動畫':'播放動畫'}>{reducedMotion?<ArrowRight size={14}/>:playing?<Pause size={13} fill="currentColor"/>:<Play size={13} fill="currentColor"/>}<span>{reducedMotion?'下一步':playing?'暫停':'播放'}</span></button><label className="sa-speed"><span className="sa-sr-only">動畫播放速度</span><select value={speed} onChange={event=>setSpeed(Number(event.target.value))} disabled={reducedMotion} aria-label="動畫播放速度">{[.5,1,1.5,2].map(value=><option key={value} value={value}>{value}×</option>)}</select></label></div>
      <div className="sa-scrubber"><input type="range" min="0" max={Math.max(0,total-1)} step="1" value={currentStep} disabled={total<2} onChange={event=>seek(Number(event.target.value))} aria-label="動畫步驟" aria-valuetext={total?`第 ${currentStep+1} 步：${current?.title||''}`:'尚無步驟'} style={{'--sa-progress':`${total>1?currentStep/(total-1)*100:0}%`} as CSSProperties}/><div className="sa-step-marks">{visual.steps.map((item,index)=><button key={index} type="button" className={index===currentStep?'sa-mark-current':index<currentStep?'sa-mark-past':''} onClick={()=>seek(index)} aria-label={`前往第 ${index+1} 步：${item.title}`} aria-current={index===currentStep?'step':undefined} title={item.title}><span>{index+1}</span></button>)}</div></div>
      <div className="sa-next-prev"><button type="button" className="sa-small-button" onClick={()=>seek(currentStep-1)} disabled={currentStep===0||!total} aria-label="上一步"><ArrowLeft size={15}/></button><button type="button" className="sa-small-button" onClick={()=>seek(currentStep+1)} disabled={currentStep>=total-1||!total} aria-label="下一步"><ArrowRight size={15}/></button></div>
    </div>
    <div className="sa-stage-toolbar"><span><i className={playing?'sa-running':''}/>{playing?'正在播放':reducedMotion?'逐步探索':'可互動場景'}{changedNodes>0&&!masked&&<em>{changedNodes} 個狀態更新</em>}</span><div className="sa-stage-tools">{expanded&&<button type="button" onClick={()=>setZoom(value=>!value)} aria-pressed={zoom} aria-label={zoom?'縮回完整場景':'原尺寸檢視'} title={zoom?'縮回完整場景':'原尺寸檢視'}>{zoom?<ZoomOut size={13}/>:<ZoomIn size={13}/>}</button>}<button ref={expandButton} type="button" onClick={()=>{setZoom(false);setExpanded(value=>!value);}} aria-pressed={expanded} aria-label={expanded?'關閉放大檢視':'放大動畫工作室'} title={expanded?'關閉放大檢視':'放大動畫工作室'}>{expanded?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button></div></div>
    <div ref={stageRef} className={`sa-stage sa-layout-${scene.layout}${zoom?' sa-zoomed':''}`} tabIndex={0} role="region" aria-label="可捲動的互動節點圖" aria-describedby={`${id}-stage-hint`}>
      <div className="sa-dot-grid" aria-hidden="true"/>
      <svg className="sa-svg" style={{minWidth:zoom?`${Math.min(drawing.width,900)}px`:scene.layout==='sequence'?`${drawing.width}px`:undefined}} viewBox={`0 0 ${drawing.width} ${drawing.height}`} role="group" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{`${visual.title}：${current?.title||'場景總覽'}`}</title><desc id={`${id}-desc`}>{masked?'本步變化已隱藏，先預測再揭曉':current?.description||visual.caption}。點擊節點可檢視完整狀態與關係。</desc>
        <defs>{edgeTypeList.map(type=><marker key={type} id={`${id}-arrow-${type}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" className={`sa-arrow sa-type-${type}`}/></marker>)}<marker id={`${id}-arrow-idle`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#c4cedf" strokeWidth="1.5"/></marker></defs>
        {scene.layout==='layers'&&[...new Set([...drawing.boxes.values()].map(box=>box.y))].map((y,index)=><g className="sa-layer-band" key={y} aria-hidden="true"><rect x="15" y={y-14} width={drawing.width-30} height="184" rx="22"/><text x="24" y={y+173}>{String(index+1).padStart(2,'0')}</text></g>)}
        {scene.layout==='memory'&&<g className="sa-memory-background" aria-hidden="true">{[...drawing.boxes.entries()].map(([key,box])=><g key={key}><path d={`M ${box.x+15} ${box.y-9} V ${box.y-17} H ${box.x+box.width-15} V ${box.y-9}`}/><path d={`M ${box.x+15} ${box.y+box.height+9} V ${box.y+box.height+17} H ${box.x+box.width-15} V ${box.y+box.height+9}`}/></g>)}</g>}
        {scene.layout==='sequence'?<>
          {[...drawing.boxes.entries()].map(([key,box])=><g key={key} aria-hidden="true"><line className="sa-lifeline" x1={box.x+box.width/2} x2={box.x+box.width/2} y1={box.y+box.height+5} y2={drawing.height-30}/><circle className="sa-lifeline-end" cx={box.x+box.width/2} cy={drawing.height-30} r="3"/></g>)}
          {sequenceEdges.length===0&&<text className="sa-sequence-empty" x={drawing.width/2} y="267" textAnchor="middle">此步未標示互動連線，請查看節點狀態。</text>}
          {sequenceEdges.map((edge,index)=>{
            const from=drawing.boxes.get(edge.from)!,to=drawing.boxes.get(edge.to)!;
            const y=237+index*58;const ax=from.x+from.width/2,bx=to.x+to.width/2;
            const path=`M ${ax} ${y} L ${bx-Math.sign(bx-ax)*7} ${y}`;
            return <EdgePath key={`${currentStep}:${edge.id}`} edge={edge} path={path} labelX={(ax+bx)/2} labelY={y-13} active={true} playing={playing&&!reducedMotion} speed={speed} id={id} labelWidth={Math.min(Math.abs(bx-ax)-18,220)}/>;
          })}
        </>:edges.map((edge,index)=>{
          const from=drawing.boxes.get(edge.from),to=drawing.boxes.get(edge.to);if(!from||!to)return null;
          const parallels=edges.slice(0,index).filter(other=>(other.from===edge.from&&other.to===edge.to)||(other.from===edge.to&&other.to===edge.from)).length;
          const route=graphPath(from,to,parallels?parallels%2?1:-1:0);
          return <EdgePath key={edge.id} edge={edge} path={route.path} labelX={route.x} labelY={route.y} active={activeEdges.has(edge.id)} playing={playing&&!reducedMotion} speed={speed} id={id} showLabel={activeEdges.has(edge.id)&&!narrow} labelWidth={Math.abs(from.y-to.y)<12?Math.max(36,Math.abs(from.x-to.x)-from.width-8):140}/>;
        })}
        {visual.nodes.map((node,index)=><SceneNode key={node.id} node={node} box={drawing.boxes.get(node.id)!} index={index} state={currentStates.get(node.id)} previous={previousStates.get(node.id)} active={activeNodes.has(node.id)} selected={selected?.id===node.id} groups={scene.groups} masked={masked} firstStep={currentStep===0} onSelect={()=>{setSelectedId(node.id);setInspecting(true);}}/>)}
      </svg>
    </div>
    <div className="sa-stage-footer"><span id={`${id}-stage-hint`}><MousePointer2 size={13}/>點選節點看細節 · 圖內可捲動</span><div className="sa-legend" aria-label="圖例"><span className="sa-legend-active"><i/>本步作用中</span><span className="sa-legend-changed"><i/>狀態已更新</span>{edgeTypeList.map(type=><span key={type} className={`sa-type-${type}`}><i/>{edgeLabels[type]}</span>)}</div></div>
    {scene.groups.length>0&&<div className="sa-groups">{scene.groups.map((group,index)=><span key={group.id} title={`${group.label}：${group.nodeIds.map(nodeId=>visual.nodes.find(node=>node.id===nodeId)?.label||nodeId).join('、')}`}><i style={{background:groupColors[index%groupColors.length]}}/>{group.label}<small>{group.nodeIds.length}</small></span>)}</div>}
    {scene.layout==='sequence'&&<p className="sa-sequence-note">連線表示本步互動；同一步內的垂直排列用於閱讀，不表示執行先後。</p>}
    <div className="sa-step-context"><span className="sa-eyebrow">{stepRelations.length?'本步關係':'本步焦點'}</span><div>{stepRelations.length?stepRelations.map(edge=><button type="button" key={edge.id} onClick={()=>{setSelectedId(edge.to);setInspecting(true);}} className={`sa-relation-chip sa-type-${edge.type}`}><span>{visual.nodes.find(node=>node.id===edge.from)?.label}<ArrowRight size={13}/>{visual.nodes.find(node=>node.id===edge.to)?.label}</span><small>{edge.label||edgeLabels[edge.type]}</small></button>):relatedNodes.length?relatedNodes.map(node=><button type="button" className="sa-focus-chip" key={node.id} onClick={()=>{setSelectedId(node.id);setInspecting(true);}}>{node.label}</button>):<p>此步未標示作用中的節點，可點選圖中的節點自由探索。</p>}</div></div>
    </div><aside className="sa-notes-pane">
    {current?.output&&<div className="sa-output"><div><Terminal size={13}/><span>本步輸出</span></div><code key={current.output}>{masked?'？ 先預測，再揭曉':current.output}</code></div>}
    {selected&&<div className="sa-inspector"><button className="sa-inspector-heading" type="button" aria-expanded={inspecting} aria-controls={`${id}-inspector`} onClick={()=>setInspecting(value=>!value)}><ScanEye size={14}/><span>節點檢視</span><b>{selected.label}</b>{inspecting?<ChevronUp size={14}/>:<ChevronDown size={14}/>}</button>{inspecting&&<div id={`${id}-inspector`} className="sa-inspector-content"><p className="sa-inspector-detail">{selected.detail}</p>{selectedGroups.length>0&&<div className="sa-node-groups"><Layers3 size={12}/>{selectedGroups.map(group=>group.label).join(' / ')}</div>}<div className="sa-state-comparison"><div><span>現在 · 第 {currentStep+1} 步</span><code>{selectedHidden?'？ 先預測，再揭曉':stateValue(selectedState)}</code></div>{!selectedHidden&&previousState&&selectedState&&previousState.value!==selectedState.value&&<div className="sa-before-value"><span>更新前 · 第 {currentStep} 步</span><code>{stateValue(previousState)}</code></div>}</div>{selectedState&&!selectedHidden&&<div className="sa-inspector-items"><span>項目 <b>{selectedState.items.length}</b></span>{selectedState.items.length?<ol>{selectedState.items.map((item,index)=><li key={`${index}:${item}`}><i>{index}</i><code>{item}</code></li>)}</ol>:<p>此步沒有列出項目。</p>}</div>}{connections.length>0&&<div className="sa-connections"><span>明確定義的關係</span>{connections.map(edge=><div key={edge.id} className={activeEdges.has(edge.id)?'sa-connection-active':''}><Circle size={6} fill="currentColor"/><p><b>{visual.nodes.find(node=>node.id===edge.from)?.label}</b><ArrowRight size={10}/><b>{visual.nodes.find(node=>node.id===edge.to)?.label}</b><small>{edgeLabels[edge.type]}{edge.label?` · ${edge.label}`:''}</small></p></div>)}</div>}</div>}</div>}
    <details className="sa-caption"><summary>圖解範圍與閱讀說明</summary><ProseBlocks text={visual.caption}/></details>{reducedMotion&&<p className="sa-motion-note">已依系統偏好關閉動態效果，可逐步探索。</p>}
    </aside></div>
  </section>;
  return expanded&&typeof document!=='undefined'?createPortal(<dialog ref={dialog} className="sa-dialog" aria-labelledby={`${id}-expanded-title`} onCancel={event=>{event.preventDefault();setExpanded(false);}} onClick={event=>{if(event.target===event.currentTarget)setExpanded(false);}}><div className="sa-expanded-header"><div><span>互動動畫工作室</span><h2 id={`${id}-expanded-title`}>{visual.title}</h2></div><button type="button" onClick={()=>setExpanded(false)} aria-label="關閉動畫工作室" title="關閉（Esc）"><X size={18}/></button></div>{content}</dialog>,document.body):content;
}
function EdgePath({edge,path,labelX,labelY,active,playing,speed,id,labelWidth,showLabel=true}:{edge:Edge;path:string;labelX:number;labelY:number;active:boolean;playing:boolean;speed:number;id:string;labelWidth:number;showLabel?:boolean}){
  const label=short(edge.label||edgeLabels[edge.type],Math.max(5,labelWidth/7));
  const width=Math.min(labelWidth,Math.max(35,[...label].reduce((length,char)=>length+(char.charCodeAt(0)>255?12:7),0)+12));
  return <g className={`sa-edge sa-type-${edge.type}${active?' sa-edge-active':''}`} aria-hidden="true"><title>{`${edgeLabels[edge.type]}：${edge.label}`}</title>{active&&<path className="sa-edge-glow" d={path}/>}<path className="sa-edge-line" d={path} markerEnd={`url(#${id}-${active?`arrow-${edge.type}`:'arrow-idle'})`}/>{showLabel&&<g className="sa-edge-label" transform={`translate(${labelX},${labelY})`}><rect x={-width/2} y="-12" width={width} height="20" rx="5"/><text textAnchor="middle" y="2">{label}</text></g>}{active&&playing&&<><circle className="sa-travel-glow" r="7"><animateMotion path={path} dur={`${1.7/speed}s`} repeatCount="indefinite"/></circle><circle className="sa-travel-dot" r="3.2"><animateMotion path={path} dur={`${1.7/speed}s`} repeatCount="indefinite"/></circle></>}</g>;
}
