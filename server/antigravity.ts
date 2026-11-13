import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ModelEffortOption, ModelSpeedOption, ProviderInfo, ProviderModel, ProviderSettings } from '../shared/settings.js';
import { usageOf, type ChatCall, type ChatProgress } from './ai.js';
import { AppError } from './errors.js';
import { cliBoundary } from './prompts/boundary.js';

export interface AntigravityRunOptions {
  cwd:string;
  input?:string;
  signal:AbortSignal;
  /** Called once per stdout line. A thrown error stops the process and rejects the run. */
  onLine:(line:string)=>void;
}
/** One Antigravity CLI (`agy`) invocation; resolves with the exit code after stdout closes. */
export interface AntigravityCli { run(args:string[], options:AntigravityRunOptions):Promise<number|null>; }

export const antigravityArguments = [
  '--input-format','stream-json',
  '--output-format','stream-json',
  '--disable-slash-commands',
  '--mode','accept-edits',
];

const inheritedEnvironment = [
  'HOME','USER','LOGNAME','SHELL','PATH','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR',
  'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR',
  'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE',
  'DO_NOT_TRACK',
  'GEMINI_API_KEY','GOOGLE_GEMINI_BASE_URL','AGY_ADC_AUTH','GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG','GOOGLE_CLOUD_QUOTA_PROJECT','GOOGLE_CLOUD_LOCATION',
];
export function antigravityEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const name of inheritedEnvironment)if(source[name]!==undefined)env[name]=source[name];
  return env;
}

function cancellationReason(signal:AbortSignal):Error {
  return signal.reason instanceof Error?signal.reason:new DOMException('這次工作已由使用者取消。','AbortError');
}

export function antigravityCli(path=process.env.AGY_CLI_PATH || 'agy'):AntigravityCli {
  return {run:(args,{cwd,input,signal,onLine})=>new Promise((resolve,reject)=>{
    if(signal.aborted){reject(cancellationReason(signal));return;}
    const child=spawn(path,args,{cwd,env:antigravityEnvironment(),stdio:['pipe','pipe','pipe'],shell:false});
    let buffer='';
    let settled=false;
    const exited=new Promise<void>(done=>child.once('exit',()=>done()));
    const exitWithin=(ms:number)=>new Promise<boolean>(done=>{
      const timer=setTimeout(()=>done(false),ms);
      void exited.then(()=>{clearTimeout(timer);done(true);});
    });
    const stop=async()=>{
      if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
      child.kill('SIGTERM');
      if(!await exitWithin(1500)){child.kill('SIGKILL');await exitWithin(1000);}
    };
    const finish=(error?:Error,code?:number|null)=>{
      if(settled)return;settled=true;
      signal.removeEventListener('abort',abort);
      if(error)void stop().then(()=>reject(error));
      else resolve(code??null);
    };
    const abort=()=>finish(cancellationReason(signal));
    signal.addEventListener('abort',abort,{once:true});
    const deliver=(line:string)=>{
      const trimmed=line.split('\r').at(-1)?.trim()??'';
      if(!trimmed)return true;
      try{onLine(trimmed);return true;}
      catch(error){finish(error instanceof Error?error:new AppError(502,'Antigravity CLI 通訊失敗。'));return false;}
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      if(settled)return;
      buffer+=chunk;
      if(buffer.length>4_000_000){finish(new AppError(502,'Antigravity CLI 回覆過大。'));return;}
      let newline:number;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        if(!deliver(line))return;
      }
    });
    child.stderr.resume();
    child.stdin.on('error',()=>{/* Early exit is handled via result event or exit code. */});
    child.on('error',()=>finish(new AppError(503,'無法啟動 Antigravity CLI（agy）。請安裝 Antigravity CLI 並執行 agy 完成登入，或以 AGY_CLI_PATH 指定執行檔。')));
    child.on('close',code=>{if(!settled && deliver(buffer))finish(undefined,code);});
    child.stdin.end(input??'');
  })};
}

const effortOrder=['low','medium','high','xhigh','max'] as const;
type EffortId=(typeof effortOrder)[number];
const effortDescriptions:Record<EffortId,string>={
  low:'較快、較省用量，適合簡單內容',
  medium:'平衡速度與推理深度',
  high:'較深入的推理',
  xhigh:'更深入，適合複雜程式與長篇來源',
  max:'最高推理深度，耗時與用量最多',
};
const standardSpeeds:ModelSpeedOption[]=[
  {id:'default',available:true,description:'標準速度與用量'},
  {id:'fast',available:false,description:'Antigravity CLI 透過選擇 Flash 模型或較低推理深度加速；BELL 只使用標準速度。'},
  {id:'ultrafast',available:false,description:'Antigravity CLI 未提供獨立 Ultrafast 選項。'},
];
const modelIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function splitEffortSuffix(id:string):{base:string;effort:EffortId}|undefined {
  const match=/^(.+)-(low|medium|high|xhigh|max)$/.exec(id);
  return match?{base:match[1],effort:match[2] as EffortId}:undefined;
}

/**
 * Parses `agy models` output (`<id>\t<name>` per line). `agy` lists each thinking
 * level as a distinct model ID (`gemini-4-carbon-low`, `-medium`, `-high`), so IDs
 * sharing a base become one `ProviderModel` with exact advertised `efforts`.
 */
export function parseAntigravityModels(lines:readonly string[]):ProviderModel[] {
  const listed:Array<{id:string;name:string}>=[];
  for(const raw of lines){
    const line=raw.split('\r').at(-1)?.trim()??'';
    const fields=line.split('\t');
    if(fields.length!==2)continue;
    const id=fields[0].trim();
    if(!modelIdPattern.test(id))continue;
    listed.push({id,name:fields[1].trim().slice(0,200)||id});
  }
  if(listed.length>200||new Set(listed.map(item=>item.id)).size!==listed.length){
    throw new AppError(502,'無法讀取 Antigravity 模型清單，請確認 agy 版本後重新整理。');
  }
  const plain=new Set(listed.map(item=>item.id));
  const grouped=new Map<string,{id:string;name:string;levels:EffortId[]}>();
  for(const {id,name} of listed){
    const split=splitEffortSuffix(id);
    if(!split||plain.has(split.base)){
      grouped.set(id,{id,name,levels:[]});
      continue;
    }
    const current=grouped.get(split.base)??{
      id:split.base,
      name:name.replace(new RegExp(`\\s*\\(${split.effort}\\)$`,'i'),'')||split.base,
      levels:[],
    };
    if(!current.levels.includes(split.effort))current.levels.push(split.effort);
    grouped.set(split.base,current);
  }
  return [...grouped.values()].map((entry,index)=>{
    const sorted=effortOrder.filter(level=>entry.levels.includes(level));
    const efforts:ModelEffortOption[]=sorted.length
      ?sorted.map(level=>({id:level,description:effortDescriptions[level]}))
      :[{id:'default',description:'模型預設'}];
    const defaultEffort=sorted.length?(sorted.includes('medium')?'medium':sorted[0]):'default';
    return {
      id:entry.id,
      name:entry.name,
      description:'Antigravity CLI 可用模型',
      isDefault:index===0,
      defaultEffort,
      efforts,
      speeds:structuredClone(standardSpeeds),
    };
  });
}

/** Normalizes a full suffixed ID (e.g. `gemini-3.8-flash-medium`) into `{ model, effort }` when grouped. */
export function normalizeAntigravitySettings(settings:ProviderSettings,models:readonly ProviderModel[]):ProviderSettings {
  if(settings.provider!=='antigravity'||!settings.model||models.some(item=>item.id===settings.model))return settings;
  const split=splitEffortSuffix(settings.model);
  if(!split||(settings.effort!=='default'&&settings.effort!==split.effort))return settings;
  const matched=models.find(item=>item.id===split.base&&item.efforts.some(option=>option.id===split.effort));
  return matched?{...settings,model:split.base,effort:split.effort}:settings;
}

export function resolveAntigravityModelId(model:ProviderModel,effort:string):string {
  if(model.defaultEffort==='default')return model.id;
  const chosen=effort==='default'?model.defaultEffort:effort;
  return `${model.id}-${chosen}`;
}

export async function discoverAntigravity(cli:AntigravityCli,signal:AbortSignal):Promise<ProviderInfo> {
  const lines:string[]=[];let size=0;
  const cwd=await mkdtemp(join(tmpdir(),'bell-agy-models-'));
  try{
    const code=await cli.run(['models'],{cwd,signal,onLine:line=>{
      size+=line.length;
      if(size>200_000)throw new AppError(502,'Antigravity 模型清單回覆過大。');
      lines.push(line);
    }});
    if(code!==0){
      return {id:'antigravity',name:'Antigravity',available:false,authenticated:false,message:'尚未登入 Antigravity CLI。請在伺服器終端執行 agy 完成登入，完成後重新整理。',models:[]};
    }
    const models=parseAntigravityModels(lines);
    if(!models.length){
      return {id:'antigravity',name:'Antigravity',available:false,authenticated:false,message:'尚未取得 Antigravity 可用模型。請在伺服器終端執行 agy 確認登入狀態後重新整理。',models:[]};
    }
    return {
      id:'antigravity',
      name:'Antigravity',
      available:true,
      authenticated:true,
      message:'已連接本機 Antigravity CLI（agy）；使用帳號對應額度與可用模型。',
      models,
    };
  }finally{
    await rm(cwd,{recursive:true,force:true});
  }
}

function imageExtension(mimeType:string):string {
  if(mimeType==='image/png')return 'png';
  if(mimeType==='image/webp')return 'webp';
  if(mimeType==='image/gif')return 'gif';
  return 'jpg';
}

function privateReadDenials():string[] {
  const home=process.env.HOME||homedir();
  const targets=[
    join(home,'.ssh'),join(home,'.aws'),join(home,'.gnupg'),
    join(home,'.config','gh'),join(home,'.config','gcloud'),join(home,'.config','antigravity'),
    join(home,'.gemini'),join(home,'.claude'),join(home,'.codex'),
    join(home,'.netrc'),join(home,'.git-credentials'),join(home,'.npmrc'),
  ];
  const adc=process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if(adc&&isAbsolute(adc))targets.push(adc);
  return [...new Set(targets)].map(target=>`read_file(${target})`);
}

export function parseAntigravityJson(raw:string):unknown {
  const trimmed=raw.trim();
  if(!trimmed)throw new AppError(502,'Antigravity 回覆未符合 JSON 結構，請重試。');
  const fenced=/^```(?:json)?\s*\n?([\s\S]*?)\n?```(?:\s*\n[\s\S]*)?$/i.exec(trimmed);
  const candidate=(fenced?fenced[1]:trimmed).trim();
  try{
    const parsed=JSON.parse(candidate) as unknown;
    if(parsed!==null&&typeof parsed==='object')return parsed;
  }catch{/* Fall through to balanced top-level object extraction when trailing notes follow JSON. */}
  const start=candidate.indexOf('{');
  if(start>=0){
    let depth=0;let inString=false;let escaped=false;
    for(let i=start;i<candidate.length;i++){
      const ch=candidate[i];
      if(inString){
        if(escaped)escaped=false;
        else if(ch==='\\')escaped=true;
        else if(ch==='"')inString=false;
        continue;
      }
      if(ch==='"')inString=true;
      else if(ch==='{')depth++;
      else if(ch==='}'){
        depth--;
        if(depth===0){
          try{
            const parsed=JSON.parse(candidate.slice(start,i+1)) as unknown;
            if(parsed!==null&&typeof parsed==='object')return parsed;
          }catch{break;}
          break;
        }
      }
    }
  }
  throw new AppError(502,'Antigravity 回覆未符合 JSON 結構，請重試。');
}

interface AntigravityEvent {
  event?:string;
  init?:{model?:string;permission_mode?:string};
  step_update?:{
    step_index?:number;
    state?:string;
    step_type?:string;
    text_delta?:string;
    tool_name?:string;
    tool_info?:{name?:string;parameters?:Record<string,unknown>;error?:{message?:string}};
  };
  result?:{
    status?:string;
    response?:string;
    structured_output?:unknown;
    error?:string;
    finished_reason?:string;
    denied_actions?:unknown[];
    usage?:{input_tokens?:unknown;output_tokens?:unknown;thinking_tokens?:unknown;cache_read_tokens?:unknown};
  };
}

export interface AntigravityChatOptions {
  timeoutMs?:number;
}

function turnFailure(role:string,modelId:string,errorText?:string,finishedReason?:string):AppError {
  const detail=`${errorText||''} ${finishedReason||''}`;
  if(/authentication|unauthenticated|sign in|log in|\b401\b|\b403\b/i.test(detail)){
    return new AppError(502,`${role}未完成：Antigravity CLI 登入已失效，請在伺服器執行 agy 完成登入後重新整理。`);
  }
  if(/rate.?limit|quota|resource_exhausted|\b429\b/i.test(detail)){
    return new AppError(429,`${role}未完成：Antigravity 帳號用量或速率已達上限，請稍後重試或切換其他模型。`);
  }
  if(/model.*(not found|unsupported|invalid)|unknown model|\b404\b/i.test(detail)){
    return new AppError(502,`${role}未完成：Antigravity 目前無法使用 ${modelId}，請重新整理模型清單或改選其他模型。`);
  }
  if(/max_tokens|max_output_tokens|length/i.test(detail)){
    return new AppError(502,`${role}未完成：回覆超過單次輸出上限，請縮短來源或聚焦需要學習的內容。`);
  }
  if(/safety|recitation|refusal|blocked/i.test(detail)){
    return new AppError(502,`${role}未完成：模型依安全政策拒絕處理這段內容，未儲存筆記。可改用其他模型或調整來源後重試。`);
  }
  return new AppError(502,`${role}未完成：未收到成功結束的完整教學回覆，尚未儲存筆記。`);
}

export function createAntigravityChat(settings:ProviderSettings,model:ProviderModel,cli:AntigravityCli,options:AntigravityChatOptions={}):ChatCall {
  if(!model.speeds.some(option=>option.id===settings.speed && option.available))throw new AppError(400,'這個模型尚未提供所選速度。');
  const effort=settings.effort==='default'?model.defaultEffort:settings.effort;
  if(!model.efforts.some(option=>option.id===effort))throw new AppError(400,'這個模型不支援所選 effort。');
  const resolvedModel=resolveAntigravityModelId(model,effort);
  const timeoutMs=options.timeoutMs??900_000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>900_000)throw new AppError(500,'Antigravity 教學階段期限設定無效。');
  return async(role,instruction,data,signal,onProgress,images=[])=>{
    signal.throwIfAborted();
    const input=JSON.stringify(data);
    if(input.length+instruction.length+cliBoundary.length>100_000)throw new AppError(413,'這份內容超過單次模型輸入限制，請縮短內容。');
    const deadline=new AbortController();
    const duration=timeoutMs>=60_000?`${timeoutMs/60_000} 分鐘`:`${timeoutMs} 毫秒`;
    const timeout=setTimeout(()=>deadline.abort(new AppError(504,`${role}使用 ${resolvedModel}（effort：${effort}、速度：${settings.speed}）超過本階段 ${duration} 上限，已停止等待；尚未儲存不完整筆記。`)),timeoutMs);
    const runSignal=AbortSignal.any([signal,deadline.signal]);
    let phase:ChatProgress['phase']='connecting';
    let outputChars=0;
    const progress=(next:ChatProgress['phase'])=>{
      phase=next;
      try{onProgress?.({phase,outputChars});}catch{/* A UI listener cannot terminate inference. */}
    };
    const allowedImagePaths=new Set<string>();
    let initialized=false;
    let finalResult:AntigravityEvent['result'];
    const isolationFailure=()=>new AppError(502,'Antigravity 未套用指定模型或隔離設定，教學工作已停止。');
    const actionFailure=()=>new AppError(502,'Antigravity 嘗試執行教學以外的動作，工作已停止。');
    const handle=(line:string)=>{
      let payload:AntigravityEvent;
      try{payload=JSON.parse(line) as AntigravityEvent;}catch{throw new AppError(502,'Antigravity CLI 通訊格式不正確。');}
      if(payload.event==='init'){
        if(payload.init?.model!==resolvedModel||payload.init?.permission_mode!=='request-review')throw isolationFailure();
        initialized=true;
        progress('thinking');
        return;
      }
      if(!initialized && (payload.event==='step_update'||payload.event==='result'))throw isolationFailure();
      if(payload.event==='step_update'){
        const step=payload.step_update;
        if(!step)return;
        if(step.step_type==='tool'){
          const toolName=step.tool_name??step.tool_info?.name??'';
          const targetPath=step.tool_info?.parameters?.Path??step.tool_info?.parameters?.path;
          const resolvedTarget=typeof targetPath==='string'&&cwd?resolve(cwd,targetPath):'';
          if((toolName==='read_file'||toolName==='view_file')&&resolvedTarget&&allowedImagePaths.has(resolvedTarget)){
            if(step.state==='ERROR')throw actionFailure();
            progress(phase==='writing'?'writing':'thinking');
            return;
          }
          throw actionFailure();
        }
        if(step.step_type==='agent_response'){
          if(typeof step.text_delta==='string'&&step.text_delta.length>0){
            outputChars+=step.text_delta.length;
            progress('writing');
          }else{
            progress(phase==='writing'?'writing':'thinking');
          }
        }
        return;
      }
      if(payload.event==='result')finalResult=payload.result;
    };
    let cwd:string|undefined;
    progress('connecting');
    try{
      cwd=await mkdtemp(join(tmpdir(),'bell-agy-'));
      cwd=await realpath(cwd);
      const imageLines:string[]=[];
      for(let index=0;index<images.length;index++){
        const image=images[index];
        const filePath=join(cwd,`page-${index+1}.${imageExtension(image.mimeType)}`);
        await writeFile(filePath,Buffer.from(image.data,'base64'),{mode:0o600});
        allowedImagePaths.add(filePath);
        imageLines.push(`- ${image.label}: ${filePath}`);
      }
      const sessionSettings={
        toolPermission:'request-review',
        enableTerminalSandbox:false,
        allowNonWorkspaceAccess:false,
        permissions:{
          allow:[...allowedImagePaths].map(filePath=>`read_file(${filePath})`),
          ask:[],
          deny:allowedImagePaths.size
            ?[...privateReadDenials(),'write_file(*)','command(*)','read_url(*)','execute_url(*)','mcp(*)']
            :['read_file(*)','write_file(*)','command(*)','read_url(*)','execute_url(*)','mcp(*)'],
        },
      };
      const toolNotice=allowedImagePaths.size
        ?'[執行環境限制] 此回合僅允許呼叫 view_file / read_file 檢視下方列出的頁面影像檔；禁止呼叫任何其他工具（write_file、run_command、search_web、read_url、瀏覽器、MCP、schedule 或 invoke_subagent 子代理皆已停用或禁止，呼叫被拒工具會直接中斷回合）。請檢視影像後獨立完成作答，只輸出單一有效 JSON 物件（以 { 開頭、以 } 結尾，不要 Markdown 圍欄，也不要在 JSON 前後附加任何摘要或說明文字）。'
        :'[執行環境限制] 此回合僅能依本提示詞作答：禁止呼叫任何工具（read_file、write_file、run_command、search_web、read_url、瀏覽器、MCP、schedule 或 invoke_subagent 子代理皆已停用或禁止，呼叫被拒工具會直接中斷回合）。請獨立完成作答，只輸出單一有效 JSON 物件（以 { 開頭、以 } 結尾，不要 Markdown 圍欄，也不要在 JSON 前後附加任何摘要或說明文字）。';
      const promptParts=[
        toolNotice,
        `${cliBoundary}\n代理角色：${role}\n${instruction}`,
        `<UNTRUSTED_INPUT_JSON>\n${input}\n</UNTRUSTED_INPUT_JSON>`,
        ...(imageLines.length?[`[附加頁面影像檔（請以完整絕對路徑依序呼叫 view_file 讀取對應檔案）]\n${imageLines.join('\n')}`]:[]),
      ];
      const args=[...antigravityArguments,'--model',resolvedModel,'--settings',JSON.stringify(sessionSettings)];
      const stdinLine=`${JSON.stringify({event:'user',message:{content:promptParts.join('\n\n')}})}\n`;
      await cli.run(args,{cwd,input:stdinLine,signal:runSignal,onLine:handle});
      const usage=finalResult?.usage&&usageOf({
        inputTokens:finalResult.usage.input_tokens,
        cachedInputTokens:finalResult.usage.cache_read_tokens,
        outputTokens:finalResult.usage.output_tokens,
        reasoningTokens:finalResult.usage.thinking_tokens,
      });
      if(usage)try{onProgress?.({phase,outputChars,usage});}catch{/* A UI listener cannot terminate inference. */}
      if(!finalResult)throw new AppError(502,`${role}已結束，但 Antigravity CLI 未回傳完整教學內容，尚未儲存筆記。`);
      if(Array.isArray(finalResult.denied_actions)&&finalResult.denied_actions.length>0)throw actionFailure();
      if(finalResult.status!=='SUCCESS')throw turnFailure(role,resolvedModel,finalResult.error,finalResult.finished_reason);
      const final=finalResult.structured_output!=null?JSON.stringify(finalResult.structured_output):(finalResult.response??'');
      if(!final.trim())throw new AppError(502,`${role}已結束，但 Antigravity CLI 未回傳完整教學內容，尚未儲存筆記。`);
      if(final.length>700_000)throw new AppError(502,'Antigravity CLI 回覆過大。');
      return parseAntigravityJson(final);
    }finally{
      clearTimeout(timeout);
      if(cwd)await rm(cwd,{recursive:true,force:true});
    }
  };
}
