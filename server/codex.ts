import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProviderInfo, ProviderModel, ProviderSettings, ModelSpeedOption } from '../shared/settings.js';
import { usageOf, type ChatCall, type ChatProgress, type ChatUsage } from './ai.js';
import { AppError } from './errors.js';
import { cliBoundary } from './prompts/boundary.js';

interface RpcNotification { method:string; params?:Record<string,unknown>; }
export interface CodexRpc {
  cwd:string;
  codexHome?:string;
  request<T=unknown>(method:string, params:unknown):Promise<T>;
  subscribe(listener:(event:RpcNotification)=>void, onError:(error:Error)=>void):()=>void;
  close():Promise<void>;
}
export type CodexRpcFactory = (signal:AbortSignal)=>Promise<CodexRpc>;
interface RuntimeModel {
  model:string; displayName:string; description:string; hidden?:boolean; isDefault?:boolean;
  defaultReasoningEffort:string;
  supportedReasoningEfforts:Array<{reasoningEffort:string; description:string}>;
  serviceTiers?:Array<{id:string; name:string; description:string}>;
  availableAccessPrograms?:{cyber?:string[]}|null;
}
interface Account { account?:{type:string}|null; requiresOpenaiAuth:boolean; }
interface ModelPage { data:RuntimeModel[]; nextCursor?:string|null; }
interface EffectiveConfig { config:{mcp_servers?:Record<string,unknown>}; }

// These settings apply before startup, so hooks, plugins and tools cannot start
// while examining a pasted source. Keep the user's existing authentication in
// Codex's own credential store; BELL never reads or copies that credential.
const disabledFeatures = [
  'shell_tool','unified_exec','code_mode','code_mode_host','apps','plugins','hooks',
  'multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use',
  'image_generation','view_image','workspace_dependencies','goals','sleep_tool',
  'memories','skill_search','tool_suggest','remote_plugin','request_permissions_tool',
];
export const codexArguments = [
  'app-server','--listen','stdio://',
  '-c','web_search="disabled"','-c','project_doc_max_bytes=0',
  '-c','skills.include_instructions=false','-c','skills.bundled.enabled=false',
  '-c','features.skip_host_skill_discovery=true','-c','allow_login_shell=false',
  '-c','approval_policy="never"','-c','sandbox_mode="read-only"',
  '-c','include_apps_instructions=false','-c','include_collaboration_mode_instructions=false',
  ...disabledFeatures.flatMap(feature=>['-c',`features.${feature}=false`]),
];

const GLOBAL_INSTRUCTION_FILES = new Set(['AGENTS.md','AGENTS.override.md']);
const defaultCodexHome = (env:NodeJS.ProcessEnv=process.env)=>env.CODEX_HOME?.trim() || join(homedir(),'.codex');
function canonicalDir(dir:string):string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}
export function hasUnexpectedInstructionSources(sources:readonly string[]|undefined, codexHome?:string):boolean {
  if(!sources?.length)return false;
  if(!codexHome)return true;
  const expectedDir=canonicalDir(codexHome);
  return sources.some(source=>!GLOBAL_INSTRUCTION_FILES.has(basename(source)) || canonicalDir(dirname(source))!==expectedDir);
}

class StdioRpc implements CodexRpc {
  private id=0;
  private buffer='';
  private closed=false;
  private failure?:Error;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private listeners=new Set<{event:(event:RpcNotification)=>void; error:(error:Error)=>void}>();
  private readonly abort:()=>void;
  constructor(private child:ChildProcessWithoutNullStreams, public cwd:string, private signal:AbortSignal, public codexHome?:string) {
    this.abort=()=>this.fail(signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled','AbortError'));
    signal.addEventListener('abort',this.abort,{once:true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>this.receive(chunk));
    child.stdin.on('error',()=>this.fail(new AppError(502,'Codex 輸入連線已關閉。')));
    child.stdout.on('error',()=>this.fail(new AppError(502,'Codex 輸出連線已關閉。')));
    // stderr may contain paths or server diagnostics. Drain, never expose it to
    // browser clients or include it in persisted notes.
    child.stderr.resume();
    child.on('error',()=>this.fail(new AppError(503,'無法啟動 Codex CLI。請安裝 Codex 並執行 codex login。')));
    child.on('exit',()=>{ if (!this.closed) this.fail(new AppError(502,'Codex 連線已中斷，請重試。')); });
    if (signal.aborted) this.abort();
  }
  private fail(error:Error):void {
    if (this.failure || this.closed) return;
    this.failure=error;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}
    this.pending.clear();
    for(const listener of this.listeners) listener.error(error);
    this.child.kill('SIGTERM');
  }
  private receive(chunk:string):void {
    if(this.closed || this.failure) return;
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>2_000_000){this.fail(new AppError(502,'Codex 回覆過大。'));return;}
    let newline:number;
    while((newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
      if(!line.trim()) continue;
      let message:{id?:number;method?:string;params?:Record<string,unknown>;result?:unknown;error?:{code?:number}};
      try{message=JSON.parse(line);}catch{this.fail(new AppError(502,'Codex 通訊格式不正確。'));return;}
      // No approval, interactive input, or dynamic tool request is ever accepted.
      if(message.method && message.id !== undefined){
        this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'BELL is a text-only client; tool actions are disabled.'}})+'\n');
        this.fail(new AppError(502,'Codex 嘗試呼叫工具，純文字教學工作已停止。'));return;
      }
      if(message.id !== undefined){
        const item=this.pending.get(message.id);if(!item) continue;
        clearTimeout(item.timer);this.pending.delete(message.id);
        if(message.error)item.reject(new AppError(502,'Codex 拒絕本次請求。請確認模型權限、effort 與速度選項，並檢查 Codex 登入狀態。'));
        else item.resolve(message.result);
      }else if(message.method){
        for(const listener of this.listeners) listener.event({method:message.method,params:message.params});
      }
    }
  }
  request<T=unknown>(method:string,params:unknown):Promise<T>{
    if(this.failure)return Promise.reject(this.failure);
    if(this.closed)return Promise.reject(new AppError(502,'Codex 連線已關閉。'));
    return new Promise<T>((resolve,reject)=>{
      const id=++this.id;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new AppError(504,'Codex 連線逾時。'));},30_000);
      this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error)this.fail(new AppError(502,'無法寫入 Codex 連線。'));});
    });
  }
  subscribe(event:(event:RpcNotification)=>void,error:(error:Error)=>void):()=>void{
    const listener={event,error};this.listeners.add(listener);
    if(this.failure)queueMicrotask(()=>error(this.failure!));
    return ()=>this.listeners.delete(listener);
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;
    this.signal.removeEventListener('abort',this.abort);
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new AppError(502,'Codex 連線已關閉。'));}
    this.pending.clear();this.listeners.clear();
    const child=this.child;
    if(child.exitCode===null && child.signalCode===null){
      await new Promise<void>(resolve=>{
        const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1500);
        child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
      });
    }
    await rm(this.cwd,{recursive:true,force:true});
  }
}
export function codexRpcFactory(path=process.env.CODEX_CLI_PATH || 'codex'):CodexRpcFactory{
  return async signal=>{
    signal.throwIfAborted();
    const cwd=await mkdtemp(join(tmpdir(),'bell-codex-'));
    const child=spawn(path,codexArguments,{cwd,stdio:['pipe','pipe','pipe'],shell:false});
    const rpc=new StdioRpc(child,cwd,signal,defaultCodexHome());
    try{
      await rpc.request('initialize',{clientInfo:{name:'bell_explain',title:'BELL Explain',version:'0.2.0'},capabilities:{experimentalApi:true}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
      return rpc;
    }catch(error){await rpc.close();throw error;}
  };
}
export function normalizeCodexModel(model:RuntimeModel):ProviderModel{
  const tiers=model.serviceTiers || [];
  const speeds:ModelSpeedOption[]=[{id:'default',available:true,description:'標準速度與用量',serviceTier:'default'}];
  for(const speed of ['fast','ultrafast'] as const){
    // A tier's display name is catalog data, but the request always uses its
    // advertised id. Do not invent an Ultrafast API value or swap models.
    const tier=tiers.find(item=>item.name.toLowerCase().replace(/[\s_-]/g,'')===speed || item.id===speed || (speed==='fast' && item.id==='priority'));
    speeds.push(tier?{id:speed,available:true,description:tier.description,serviceTier:tier.id}:{id:speed,available:false,description:`目前帳號／模型未提供 ${speed==='fast'?'Fast':'Ultrafast'}，重新整理可更新可用性。`});
  }
  return {id:model.model,name:model.displayName,description:model.description,isDefault:!!model.isDefault,defaultEffort:model.defaultReasoningEffort,efforts:model.supportedReasoningEfforts.map(option=>({id:option.reasoningEffort,description:option.description})),speeds};
}
export async function discoverCodex(factory:CodexRpcFactory,signal:AbortSignal):Promise<ProviderInfo>{
  const rpc=await factory(signal);
  try{
    const account=await rpc.request<Account>('account/read',{});
    if(!account.account)return {id:'codex',name:'Codex',available:false,authenticated:false,message:'尚未登入 Codex。請在終端執行 codex login，完成後重新整理。',models:[]};
    const models:RuntimeModel[]=[];let cursor:string|undefined;
    do{
      const page=await rpc.request<ModelPage>('model/list',{includeHidden:false,limit:100,...(cursor?{cursor}:{})});
      models.push(...page.data);cursor=page.nextCursor||undefined;
      if(models.length>500)throw new AppError(502,'Codex 模型清單超過限制。');
    }while(cursor);
    // Specialized access-program-only models need a separate explicit workflow.
    const visible=models.filter(model=>!model.hidden && (!model.availableAccessPrograms?.cyber?.length || model.availableAccessPrograms.cyber.includes('standard')));
    return {id:'codex',name:'Codex',available:visible.length>0,authenticated:true,message:visible.length?`已連接本機 Codex · ${account.account.type==='chatgpt'?'ChatGPT 登入':'Codex API 登入'}；使用帳號對應額度。`:'Codex 尚未回傳可用的教學模型。',models:visible.map(normalizeCodexModel)};
  }finally{await rpc.close();}
}

export interface CodexChatOptions {
  /** A bounded role deadline; injectable for short deterministic tests. */
  timeoutMs?:number;
}
function cancellationReason(signal:AbortSignal):Error {
  return signal.reason instanceof Error?signal.reason:new DOMException('這次工作已由使用者取消。','AbortError');
}
function withSignal<T>(pending:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted){void pending.catch(()=>{});return Promise.reject(cancellationReason(signal));}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(cancellationReason(signal));};
    signal.addEventListener('abort',abort,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
interface TurnFailure { codexErrorInfo?:string|Record<string,unknown>|null; }
function turnFailure(role:string,error?:TurnFailure,status?:string):AppError {
  const info=error?.codexErrorInfo;
  const code=typeof info==='string'?info:info&&Object.keys(info)[0];
  if(code==='usageLimitExceeded'||code==='sessionBudgetExceeded')return new AppError(429,`${role}未完成：Codex 帳號可用額度已達上限，請查看 Codex 用量。`);
  if(code==='rateLimitExceeded'||code==='serverOverloaded')return new AppError(429,`${role}未完成：Codex 暫時受到速率或服務容量限制，請稍後重試。`);
  if(code==='unauthorized')return new AppError(502,`${role}未完成：Codex 授權已失效，請重新執行 codex login。`);
  if(code==='contextWindowExceeded')return new AppError(413,`${role}未完成：這份來源超過模型可接受的上下文大小，請聚焦需要學習的內容。`);
  if(code&&['responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts','httpConnectionFailed'].includes(code))return new AppError(502,`${role}未完成：Codex 上游連線中斷或重試失敗，尚未取得完整回覆。`);
  return new AppError(502,`${role}${status==='interrupted'?'被 Codex 中斷':'未完成'}：未收到成功結束的完整教學回覆，尚未儲存筆記。`);
}
export function createCodexChat(settings:ProviderSettings,model:ProviderModel,factory:CodexRpcFactory,options:CodexChatOptions={}):ChatCall{
  const speed=model.speeds.find(option=>option.id===settings.speed && option.available);
  if(!speed?.serviceTier)throw new AppError(400,'這個模型尚未提供所選速度。');
  const effort=settings.effort==='default'?model.defaultEffort:settings.effort;
  if(!model.efforts.some(option=>option.id===effort))throw new AppError(400,'這個模型不支援所選 effort。');
  const timeoutMs=options.timeoutMs??900_000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>900_000)throw new AppError(500,'Codex 教學階段期限設定無效。');
  return async(role,instruction,data,signal,onProgress,images=[])=>{
    signal.throwIfAborted();
    const input=JSON.stringify(data);
    if(input.length+instruction.length+cliBoundary.length>100_000)throw new AppError(413,'這份內容超過單次模型輸入限制，請縮短內容。');
    const deadline=new AbortController();
    const duration=timeoutMs>=60_000?`${timeoutMs/60_000} 分鐘`:`${timeoutMs} 毫秒`;
    const timeout=setTimeout(()=>deadline.abort(new AppError(504,`${role}使用 ${model.id}（effort：${effort}、速度：${settings.speed}）超過本階段 ${duration} 上限，已停止等待；尚未儲存不完整筆記。`)),timeoutMs);
    const runSignal=AbortSignal.any([signal,deadline.signal]);
    let rpc:CodexRpc|undefined;
    let closed=false;
    let unsubscribe=()=>{};
    let phase:ChatProgress['phase']='connecting';
    // Progress contains observation metadata only. Never forward commentary,
    // reasoning text, partial JSON, error details, or credential information.
    const streamed=new Map<string,{phase?:string;chars:number}>();
    const outputChars=()=>[...streamed.values()].reduce((sum,item)=>sum+(!item.phase||item.phase==='final_answer'?item.chars:0),0);
    let usage:ChatUsage|undefined;
    const progress=(next:ChatProgress['phase'],final=false)=>{
      phase=next;
      try{onProgress?.({phase,outputChars:outputChars(),...(final&&usage?{usage}:{})});}catch{/* A UI listener cannot terminate inference. */}
    };
    const close=async()=>{if(rpc&&!closed){closed=true;await rpc.close();}};
    progress('connecting');
    try{
      // Race every phase against our own signal. Adapters that ignore aborts
      // must not keep BELL waiting; a late factory result is still closed.
      const acquiring=factory(runSignal).then(async client=>{
        rpc=client;
        if(runSignal.aborted){await close();throw cancellationReason(runSignal);}
        return client;
      });
      const client=await withSignal(acquiring,runSignal);
      const request=<T>(method:string,params:unknown)=>withSignal(client.request<T>(method,params),runSignal);
      const effective=await request<EffectiveConfig>('config/read',{includeLayers:false});
      const config:Record<string,unknown>={model_reasoning_effort:effort,developer_instructions:'',web_search:'disabled',project_doc_max_bytes:0};
      for(const name of Object.keys(effective.config.mcp_servers||{}))config[`mcp_servers.${name}.enabled`]=false;
      const thread=await request<{thread:{id:string};model:string;serviceTier:string|null;reasoningEffort?:string|null;sandbox:{type:string;networkAccess?:boolean};instructionSources?:string[]}>('thread/start',{
        cwd:client.cwd,model:model.id,modelProvider:'openai',ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
        environments:[],runtimeWorkspaceRoots:[],dynamicTools:[],selectedCapabilityRoots:[],
        baseInstructions:cliBoundary,developerInstructions:`代理角色：${role}\n${instruction}`,config,
        serviceTier:speed.serviceTier,allowProviderModelFallback:false,
      });
      const tierMatches=thread.serviceTier===speed.serviceTier || (speed.serviceTier==='default' && thread.serviceTier===null);
      if(thread.model!==model.id || !tierMatches || (thread.reasoningEffort && thread.reasoningEffort!==effort) || thread.sandbox.type!=='readOnly' || thread.sandbox.networkAccess===true || hasUnexpectedInstructionSources(thread.instructionSources,client.codexHome ?? defaultCodexHome()))throw new AppError(502,'Codex 未套用指定模型或隔離設定，教學工作已停止。');
      const messages=new Map<string,string>();
      let rejectCompletion:(error:Error)=>void=()=>{};
      const completion=new Promise<unknown>((resolve,reject)=>{
        rejectCompletion=reject;
        unsubscribe=client.subscribe(event=>{
          const params=event.params;
          if(params?.threadId!==thread.thread.id)return;
          const item=params.item as {id?:string;type?:string;text?:string;phase?:string}|undefined;
          if(event.method==='model/rerouted'&&params.toModel!==model.id){reject(new AppError(502,`${role}收到 Codex 改用其他模型的通知；為保留你選擇的 ${model.id}，已停止本次工作。`));return;}
          if(event.method==='error'){
            if(params.willRetry===true){progress('connecting');return;}
            reject(turnFailure(role,params.error as TurnFailure|undefined));return;
          }
          if(event.method==='modelProvider/authRecoveryStarted'){progress('connecting');return;}
          if(event.method==='turn/started'||event.method==='modelProvider/authRecoveryCompleted')progress('thinking');
          if(event.method.startsWith('item/reasoning/')||event.method==='thread/tokenUsage/updated')progress(phase==='writing'?'writing':'thinking');
          if(event.method==='item/started' && item?.type && !['agentMessage','userMessage','reasoning','contextCompaction'].includes(item.type)){
            reject(new AppError(502,'Codex 嘗試執行教學以外的動作，工作已停止。'));return;
          }
          if(event.method==='item/started'&&item?.type==='reasoning')progress(phase==='writing'?'writing':'thinking');
          if(event.method==='item/started'&&item?.type==='agentMessage'&&item.id){
            streamed.set(item.id,{phase:item.phase,chars:0});
            if(!item.phase||item.phase==='final_answer')progress('writing');
          }
          if(event.method==='item/agentMessage/delta'&&typeof params.itemId==='string'&&typeof params.delta==='string'){
            const entry=streamed.get(params.itemId)||{chars:0};
            entry.chars+=params.delta.length;streamed.set(params.itemId,entry);
            if(!entry.phase||entry.phase==='final_answer')progress('writing');
          }
          if(event.method==='item/completed' && item?.type==='agentMessage' && item.text){
            if(item.text.length>700_000){reject(new AppError(502,'Codex 回覆過大。'));return;}
            const itemId=item.id||String(messages.size);
            streamed.set(itemId,{phase:item.phase,chars:item.text.length});
            if(!item.phase || item.phase==='final_answer'){messages.set(itemId,item.text);progress('writing');}
          }
          if(event.method==='thread/tokenUsage/updated'){
            // Each lesson stage runs in its own ephemeral thread, so the total is this call.
            const total=(params.tokenUsage as {total?:Record<string,unknown>}|undefined)?.total;
            if(total)usage=usageOf({inputTokens:total.inputTokens,cachedInputTokens:total.cachedInputTokens,outputTokens:total.outputTokens,reasoningTokens:total.reasoningOutputTokens});
          }
          if(event.method==='turn/completed'){
            const turn=params.turn as {status?:string;error?:TurnFailure}|undefined;
            if(usage)progress(phase,true);
            if(turn?.status!=='completed'){reject(turnFailure(role,turn?.error,turn?.status));return;}
            const final=[...messages.values()].at(-1);
            if(!final){reject(new AppError(502,`${role}已結束，但 Codex 未回傳完整教學內容，尚未儲存筆記。`));return;}
            try{resolve(JSON.parse(final.replace(/^\s*```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')));}
            catch{reject(new AppError(502,'Codex 回覆未符合 JSON 結構，請重試。'));}
          }
        },reject);
      });
      void completion.catch(()=>{});
      try{
        // Page images follow the JSON data, each introduced by its page label.
        const pages=images.flatMap(image=>[{type:'text',text:image.label},{type:'image',url:`data:${image.mimeType};base64,${image.data}`}]);
        await request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:input},...pages],model:model.id,effort,serviceTierForTurn:speed.serviceTier,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
      }catch(error){rejectCompletion(error instanceof Error?error:new Error('Codex request failed'));}
      return await withSignal(completion,runSignal);
    }finally{clearTimeout(timeout);unsubscribe();await close();}
  };
}
