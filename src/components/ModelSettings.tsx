import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Bot, Check, CheckCircle2, CircleAlert, Cpu, Gauge, LoaderCircle, Orbit, RefreshCw, Server, Sparkles, Zap } from 'lucide-react';
import { defaultPonytailMode, ponytailModes, type PonytailMode } from '../../shared/efficiency';
import type { AIProvider, AISpeed, ProviderCatalog, ProviderInfo, ProviderModel, ProviderSettings, ProviderSnapshot } from '../../shared/settings';
import Select from '../ui/Select';
import './model-settings.css';

interface ModelSettingsProps { onSaved:()=>void; onError?:(message:string)=>void; }
const speedLabels:Record<AISpeed,string>={default:'標準',fast:'快速',ultrafast:'極速'};
const ponytailLabels:Record<PonytailMode,string>={full:'完整 · 預設',lite:'輕量',off:'關閉'};
const ponytailShortLabels:Record<PonytailMode,string>={full:'Ponytail 完整',lite:'Ponytail 輕量',off:'Ponytail 關閉'};
const providerLabels:Record<AIProvider,{name:string;caption:string;ready:string;Icon:typeof Server}>={
  codex:{name:'Codex',caption:'沿用本機帳號與額度',ready:'已連接',Icon:Sparkles},
  claude:{name:'Claude Code',caption:'沿用本機 Claude 登入',ready:'已連接',Icon:Bot},
  antigravity:{name:'Antigravity',caption:'沿用本機 agy 登入',ready:'已連接',Icon:Orbit},
  api:{name:'OpenAI 相容 API',caption:'使用自己的模型服務',ready:'已設定',Icon:Server},
};
const effortLabels:Record<string,string>={none:'不推理',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'極高',max:'最高',ultra:'最高'};
function effortName(effort:string){return effortLabels[effort]||effort;}
function firstModel(provider?:ProviderInfo){return provider?.models.find(model=>model.isDefault)||provider?.models[0];}
async function modelRequest<T>(path:string,signal:AbortSignal,init?:RequestInit):Promise<T>{
  const response=await fetch(`/api${path}`,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(35_000)])});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(body?.error || '模型服務暫時無法回應，請稍後再試。');
  if(!body)throw new Error('無法讀取模型設定，請重新整理。');
  return body as T;
}

export default function ModelSettings({onSaved,onError}:ModelSettingsProps){
  const [catalog,setCatalog]=useState<ProviderCatalog>();
  const [saved,setSaved]=useState<ProviderSettings>();
  const [draft,setDraft]=useState<ProviderSettings>();
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const mounted=useRef(false);
  const controllers=useRef(new Set<AbortController>());
  const errorCallback=useRef(onError);
  errorCallback.current=onError;
  function report(cause:unknown){
    if(!mounted.current)return;
    if(cause instanceof Error && cause.name==='AbortError')return;
    const message=cause instanceof Error && cause.name==='TimeoutError'?'讀取模型服務逾時，請確認 Codex／Claude Code／Antigravity 登入狀態後重試。':cause instanceof Error?cause.message:'無法更新模型設定，請稍後再試。';
    setError(message);setSuccess('');errorCallback.current?.(message);
  }
  useEffect(()=>{
    mounted.current=true;
    const controller=new AbortController();controllers.current.add(controller);
    modelRequest<ProviderSnapshot>('/settings',controller.signal)
      .then(snapshot=>{if(mounted.current){setCatalog(snapshot.catalog);setDraft(snapshot.settings);setSaved(snapshot.settings);}})
      .catch(report)
      .finally(()=>{controllers.current.delete(controller);if(mounted.current&&!controller.signal.aborted)setLoading(false);});
    return()=>{mounted.current=false;for(const item of controllers.current)item.abort();controllers.current.clear();};
  },[]);
  const provider=catalog?.providers.find(item=>item.id===draft?.provider);
  const model=provider?.models.find(item=>item.id===draft?.model);
  const savedProvider=catalog?.providers.find(item=>item.id===saved?.provider);
  const savedModel=savedProvider?.models.find(item=>item.id===saved?.model);
  const selectedSpeed=model?.speeds.find(item=>item.id===draft?.speed);
  const validEffort=!!draft && (draft.effort==='default'||model?.efforts.some(option=>option.id===draft.effort));
  const valid=!!provider?.available && !!model && validEffort && !!selectedSpeed?.available;
  const dirty=!!draft && JSON.stringify(draft)!==JSON.stringify(saved);
  const busy=loading||saving||refreshing;
  function updateDraft(next:ProviderSettings){setDraft(next);setError('');setSuccess('');}
  function selectProvider(id:AIProvider){
    const target=catalog?.providers.find(item=>item.id===id);
    if(!target || draft?.provider===id)return;
    updateDraft(saved?.provider===id?{...saved}:{provider:id,model:firstModel(target)?.id||'',effort:'default',speed:'default',ponytailMode:draft?.ponytailMode??defaultPonytailMode});
  }
  function selectModel(id:string){
    if(!draft)return;
    const next=provider?.models.find(item=>item.id===id);
    if(!next)return;
    // Keep choices when the new model advertises them. Otherwise show the new
    // model's default in the form before the user explicitly saves it.
    updateDraft({...draft,model:id,effort:draft.effort==='default'||next.efforts.some(option=>option.id===draft.effort)?draft.effort:'default',speed:next.speeds.some(option=>option.id===draft.speed&&option.available)?draft.speed:'default'});
  }
  function speedKey(event:KeyboardEvent<HTMLButtonElement>,current:AISpeed){
    if(!draft||!model||busy)return;
    const choices=model.speeds.filter(option=>option.available).map(option=>option.id);
    const index=choices.indexOf(current);
    let next:AISpeed|undefined;
    if(event.key==='ArrowRight'||event.key==='ArrowDown')next=choices[(index+1)%choices.length];
    if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=choices[(index+choices.length-1)%choices.length];
    if(event.key==='Home')next=choices[0];
    if(event.key==='End')next=choices.at(-1);
    if(!next)return;
    event.preventDefault();updateDraft({...draft,speed:next});
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-speed="${next}"]`)?.focus();
  }
  async function refresh(){
    const controller=new AbortController();controllers.current.add(controller);
    setRefreshing(true);setError('');setSuccess('');
    try{
      if(!draft){
        const snapshot=await modelRequest<ProviderSnapshot>('/settings?refresh=true',controller.signal);
        if(mounted.current){setCatalog(snapshot.catalog);setDraft(snapshot.settings);setSaved(snapshot.settings);}
      }else{
        const next=await modelRequest<ProviderCatalog>('/models?refresh=true',controller.signal);
        if(mounted.current){
          setCatalog(next);
          if(!draft.model){
            const discovered=firstModel(next.providers.find(item=>item.id===draft.provider));
            if(discovered)setDraft({...draft,model:discovered.id});
          }
        }
      }
    }catch(cause){report(cause);}
    finally{controllers.current.delete(controller);if(mounted.current)setRefreshing(false);}
  }
  async function save(){
    if(!draft||!valid||busy)return;
    const controller=new AbortController();controllers.current.add(controller);
    setSaving(true);setError('');setSuccess('');
    try{
      const snapshot=await modelRequest<ProviderSnapshot>('/settings',controller.signal,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
      if(mounted.current){setCatalog(snapshot.catalog);setDraft(snapshot.settings);setSaved(snapshot.settings);setSuccess('已儲存，下一次生成將使用這組設定。');onSaved();}
    }catch(cause){report(cause);}
    finally{controllers.current.delete(controller);if(mounted.current)setSaving(false);}
  }
  const effectiveEffort=draft?.effort==='default'?model?.defaultEffort:draft?.effort;
  return <section className="model-settings" aria-label="AI 模型設定" aria-busy={busy}>
    <div className="ms-intro">
      <p>Codex、Claude Code 與 Antigravity 使用這台電腦的帳號登入，不需要另外填入 API key。</p>
      <button type="button" className="ms-refresh" onClick={()=>void refresh()} disabled={busy} aria-label="重新整理模型清單" title="重新整理登入狀態與模型清單"><RefreshCw size={16} className={refreshing?'ms-spin':''}/><span>重新整理</span></button>
    </div>
    {loading?<div className="ms-loading" role="status"><LoaderCircle size={21} className="ms-spin"/><span>正在連接本機模型服務，讀取可用模型…</span></div>:<>
      {catalog&&draft&&<>
        <div className="ms-provider-grid" role="group" aria-label="模型供應商">
          {catalog.providers.map(item=>{const label=providerLabels[item.id];return <button key={item.id} type="button" className={`ms-provider${draft.provider===item.id?' ms-selected':''}`} aria-pressed={draft.provider===item.id} onClick={()=>selectProvider(item.id)} disabled={saving||refreshing}>
            <span className="ms-provider-top"><label.Icon size={19}/><b>{label.name}</b><span className="ms-selection-mark">{draft.provider===item.id&&<Check size={12}/>}</span></span>
            <span className="ms-provider-caption">{label.caption}</span>
            <span className={`ms-connection${item.available?' ms-connected':''}`}><i/>{item.available?label.ready:(item.authenticated?'暫無可用模型':'尚未設定')}</span>
          </button>;})}
        </div>
        {provider&&(provider.available||provider.authenticated)&&<div className={`ms-provider-note${provider.available?'':' ms-not-ready'}`} role="status">{provider.available?<CheckCircle2 size={15}/>:<CircleAlert size={15}/>}<p>{provider.message}</p></div>}
        {draft.provider==='codex'&&!provider?.authenticated&&<div className="ms-setup"><b>先完成一次登入</b><p>在這台電腦的終端機執行 <code>codex login</code>，完成後按「重新整理」。</p></div>}
        {draft.provider==='claude'&&!provider?.authenticated&&<div className="ms-setup"><b>先完成一次登入</b><p>在這台電腦的終端機執行 <code>claude auth login</code>，完成後按「重新整理」。</p></div>}
        {draft.provider==='antigravity'&&!provider?.authenticated&&<div className="ms-setup"><b>先完成一次登入</b><p>在這台電腦的終端機執行 <code>agy</code> 完成帳號登入，完成後按「重新整理」。</p></div>}
        {draft.provider==='api'&&<div className="ms-setup"><b>API 設定保留在伺服器</b><p>請由管理員完成 OpenAI 相容 API 設定，再重新整理。</p></div>}
        <div className="ms-controls">
          <div className="ms-field"><span>模型</span><Select label="AI 模型" value={draft.model} onChange={selectModel} disabled={busy||!provider?.models.length} options={[
            ...(!model?[{value:draft.model,label:draft.model?`${draft.model}（目前不可用）`:'等待可用模型'}]:[]),
            ...(provider?.models.map(item=>({value:item.id,label:`${item.name}${item.isDefault?' · 建議預設':''}`}))||[]),
          ]}/></div>
          <div className="ms-field"><span>推理深度</span><Select label="推理深度" value={draft.effort} onChange={effort=>updateDraft({...draft,effort})} disabled={busy||!model} options={[
            {value:'default',label:`模型預設${model&&model.defaultEffort!=='default'?`（${effortName(model.defaultEffort)}）`:''}`},
            ...(!validEffort?[{value:draft.effort,label:`${effortName(draft.effort)}（目前不可用）`}]:[]),
            ...(model?.efforts.filter(item=>item.id!=='default').map(item=>({value:item.id,label:effortName(item.id)}))||[]),
          ]}/><small className="ms-field-description">{effortDescription(model,effectiveEffort)}</small></div>
        </div>
        <div className="ms-field ms-efficiency-field"><span>效率模式</span><Select label="效率模式" value={draft.ponytailMode??defaultPonytailMode} onChange={mode=>updateDraft({...draft,ponytailMode:mode as PonytailMode})} disabled={busy} options={(['full','lite','off'] as const).filter(mode=>ponytailModes.includes(mode)).map(mode=>({value:mode,label:ponytailLabels[mode]}))}/><small className="ms-field-description">預設開啟 Ponytail 完整規則（MIT），消除冗贅語氣與過度設計，同時保留完整教材脈絡、第一手規格依據與實證細節。</small></div>
        <fieldset className="ms-speed-field"><legend>生成速度</legend><div className="ms-speed-options" role="radiogroup" aria-label="生成速度">
          {(['default','fast','ultrafast'] as const).map(speed=>{
            const option=model?.speeds.find(item=>item.id===speed);
            const Icon=speed==='default'?Gauge:speed==='fast'?Zap:Sparkles;
            return <button key={speed} type="button" role="radio" data-speed={speed} tabIndex={draft.speed===speed||(!selectedSpeed?.available&&model?.speeds.find(item=>item.available)?.id===speed)?0:-1} onKeyDown={event=>speedKey(event,speed)} aria-checked={draft.speed===speed} className={`ms-speed${draft.speed===speed?' ms-speed-selected':''}`} disabled={busy||!option?.available} onClick={()=>updateDraft({...draft,speed})} title={option?.description||'請先選擇模型'}><Icon size={17}/><b>{speedLabels[speed]}</b><span>{speed==='default'?'標準速度':option?.available?'較快生成':'尚未提供'}</span></button>;
          })}
        </div>{!selectedSpeed?.available&&<p className="ms-speed-caption">所選速度目前無法使用，請改選可用選項。</p>}
        {draft.provider==='claude'&&<p className="ms-usage">用量計入這台電腦登入的 Claude 帳號；可用模型與推理上限依訂閱方案而定。</p>}
        {draft.provider==='antigravity'&&<p className="ms-usage">用量計入這台電腦登入的 Antigravity CLI（<code>agy</code>）帳號；可用模型與推理深度依帳號權限動態讀取。</p>}
        {draft.provider==='codex'&&<p className="ms-usage">加速模式可能提高額度消耗，可用性依帳號與模型而定。<a href="https://learn.chatgpt.com/docs/agent-configuration/speed" target="_blank" rel="noreferrer">速度與用量說明<ArrowUpRight size={12}/></a></p>}
        </fieldset>
        <div className="ms-summary"><Cpu size={17}/><div><span>{dirty?'待儲存的設定':'目前使用'}</span><p>{model?.name||draft.model||'尚未選擇模型'}<i>·</i>{effectiveEffort?effortName(effectiveEffort):'模型預設'}<i>·</i>{speedLabels[draft.speed]}<i>·</i>{ponytailShortLabels[draft.ponytailMode??defaultPonytailMode]}</p></div>{!dirty&&valid&&<CheckCircle2 className="ms-summary-check" size={17}/>}</div>
        {dirty&&saved&&<p className="ms-current">目前已儲存：{savedModel?.name||saved.model||'尚未選擇'} · {saved.effort==='default'?'模型預設':effortName(saved.effort)} · {speedLabels[saved.speed]} · {ponytailShortLabels[saved.ponytailMode??defaultPonytailMode]}</p>}
      </>}
    </>}
    {error&&<div className="ms-message ms-error" role="alert"><CircleAlert size={16}/><p>{error}</p></div>}
    {success&&<div className="ms-message ms-success" role="status"><CheckCircle2 size={16}/><p>{success}</p></div>}
    {!loading&&<div className="ms-actions"><span>{dirty?'有尚未儲存的變更':'已儲存的設定保留在這台電腦'}</span>{draft?<button type="button" className="ms-save" disabled={!valid||busy||!dirty} onClick={()=>void save()}>{saving?<LoaderCircle size={16} className="ms-spin"/>:<Check size={16}/>}<span>{saving?'儲存中…':'儲存設定'}</span></button>:<button type="button" className="ms-save" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={15}/>重新連接</button>}</div>}
  </section>;
}
function effortDescription(model:ProviderModel|undefined,effort:string|undefined){
  if(!model)return '模型清單會提供各自支援的推理深度。';
  if(model.defaultEffort==='default')return '此模型使用供應商預設設定，不另外指定 effort。';
  if(effort==='ultra')return '最高推理深度，適合複雜規格、底層機制與多章節教材推導。';
  return '較深推理適合複雜問題，也可能需要更多時間與用量。';
}
