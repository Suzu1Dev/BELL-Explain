import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEffortOption, ModelSpeedOption, ProviderInfo, ProviderModel, ProviderSettings } from '../shared/settings.js';
import { usageOf, type ChatCall, type ChatProgress } from './ai.js';
import { AppError } from './errors.js';
import { cliBoundary } from './prompts/boundary.js';

export interface ClaudeRunOptions {
  cwd:string;
  input?:string;
  signal:AbortSignal;
  /** Called once per stdout line. A thrown error stops the process and rejects the run. */
  onLine:(line:string)=>void;
}
/** One Claude Code CLI invocation; resolves with the exit code after stdout closes. */
export interface ClaudeCli { run(args:string[], options:ClaudeRunOptions):Promise<number|null>; }

// Applied to every teaching turn. Safe mode skips CLAUDE.md, skills, plugins,
// hooks, MCP servers and custom agents while keeping the CLI's own login;
// `--bare` is not used because it never reads OAuth credentials.
export const claudeArguments = [
  '-p','--safe-mode','--tools','','--strict-mcp-config','--disable-slash-commands',
  '--no-session-persistence','--permission-mode','dontAsk',
  '--output-format','stream-json','--verbose','--include-partial-messages',
];
// Only what the CLI needs to find its login, network and locale. BELL's own
// API keys, sync tokens and any parent Claude Code session stay out.
const inheritedEnvironment = [
  'HOME','USER','LOGNAME','PATH','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR',
  'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE',
];
export function claudeEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const name of inheritedEnvironment)if(source[name]!==undefined)env[name]=source[name];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  return env;
}
function cancellationReason(signal:AbortSignal):Error {
  return signal.reason instanceof Error?signal.reason:new DOMException('這次工作已由使用者取消。','AbortError');
}
export function claudeCli(path=process.env.CLAUDE_CLI_PATH || 'claude'):ClaudeCli {
  return {run:(args,{cwd,input,signal,onLine})=>new Promise((resolve,reject)=>{
    if(signal.aborted){reject(cancellationReason(signal));return;}
    const child=spawn(path,args,{cwd,env:claudeEnvironment(),stdio:['pipe','pipe','pipe'],shell:false});
    let buffer='';
    let settled=false;
    const exited=new Promise<void>(done=>child.once('exit',()=>done()));
    const exitWithin=(ms:number)=>new Promise<boolean>(done=>{
      const timer=setTimeout(()=>done(false),ms);
      void exited.then(()=>{clearTimeout(timer);done(true);});
    });
    // Bounded wait for the process to exit so callers can remove its directory.
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
      if(!line.trim())return true;
      try{onLine(line);return true;}
      catch(error){finish(error instanceof Error?error:new AppError(502,'Claude Code 通訊失敗。'));return false;}
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      if(settled)return;
      buffer+=chunk;
      if(buffer.length>4_000_000){finish(new AppError(502,'Claude Code 回覆過大。'));return;}
      let newline:number;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        if(!deliver(line))return;
      }
    });
    // stderr may contain paths, account details or diagnostics. Drain, never expose it.
    child.stderr.resume();
    child.stdin.on('error',()=>{/* An early exit is reported by the result event or exit code. */});
    child.on('error',()=>finish(new AppError(503,'無法啟動 Claude Code CLI。請安裝 Claude Code 並執行 claude auth login，或以 CLAUDE_CLI_PATH 指定執行檔。')));
    child.on('close',code=>{if(!settled && deliver(buffer))finish(undefined,code);});
    child.stdin.end(input??'');
  })};
}

interface AuthStatus { loggedIn?:boolean; authMethod?:string; subscriptionType?:string; }
const effortOptions:ModelEffortOption[]=[
  {id:'low',description:'較快、較省用量，適合簡單內容'},
  {id:'medium',description:'平衡速度與推理深度'},
  {id:'high',description:'較深入的推理'},
  {id:'xhigh',description:'更深入，適合複雜程式與長篇來源'},
  {id:'max',description:'最高推理深度，耗時與用量最多'},
];
const standardSpeeds:ModelSpeedOption[]=[
  {id:'default',available:true,description:'標準速度與用量'},
  {id:'fast',available:false,description:'Claude Code 非互動模式沒有可指定並驗證的 Fast 選項；BELL 只使用標準速度。'},
  {id:'ultrafast',available:false,description:'Claude Code 未提供 Ultrafast。'},
];
// The CLI has no model directory. These are its full model names; the account's
// plan decides availability, and an unavailable model fails at generation time.
// Default efforts follow Anthropic's documented per-model defaults.
export const claudeModels:ProviderModel[]=[
  {id:'claude-opus-5-5',name:'Claude Opus 5.5',description:'深入推理與長篇內容，BELL 的 Claude 預設模型。',isDefault:true,defaultEffort:'medium',efforts:effortOptions,speeds:standardSpeeds},
  {id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',description:'速度與能力平衡，適合日常程式學習。',isDefault:false,defaultEffort:'high',efforts:effortOptions,speeds:standardSpeeds},
  {id:'claude-haiku-4-5',name:'Claude Haiku 4.5',description:'最快、最省用量；此模型不支援 effort 設定。',isDefault:false,defaultEffort:'default',efforts:[{id:'default',description:'模型預設'}],speeds:standardSpeeds},
];
export async function discoverClaude(cli:ClaudeCli,signal:AbortSignal):Promise<ProviderInfo>{
  const lines:string[]=[];let size=0;
  await cli.run(['auth','status','--json'],{cwd:tmpdir(),signal,onLine:line=>{
    size+=line.length;
    if(size>64_000)throw new AppError(502,'Claude Code 登入狀態回覆過大。');
    lines.push(line);
  }});
  let status:AuthStatus;
  // `auth status` exits non-zero when logged out; its JSON is still authoritative.
  try{status=JSON.parse(lines.join('\n')) as AuthStatus;}
  catch{throw new AppError(502,'無法讀取 Claude Code 登入狀態。請確認 Claude Code 版本支援 claude auth status。');}
  if(!status.loggedIn)return {id:'claude',name:'Claude Code',available:false,authenticated:false,message:'尚未登入 Claude Code。請在伺服器終端執行 claude auth login，完成後重新整理。',models:[]};
  const plan=status.subscriptionType?`（${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} 方案）`:'';
  const method=status.authMethod==='claude.ai'?`Claude 帳號登入${plan}`:'Claude Code 登入';
  return {id:'claude',name:'Claude Code',available:true,authenticated:true,message:`已連接本機 Claude Code · ${method}；使用帳號對應額度，可用模型依方案而定。`,models:structuredClone(claudeModels)};
}

const textBlocks=new Set(['text','thinking','redacted_thinking']);
interface ContentBlock { type?:string; text?:string; }
interface ClaudeEvent {
  type?:string; subtype?:string; error?:string;
  // system/init
  model?:string; permissionMode?:string; fast_mode_state?:string;
  tools?:unknown[]; mcp_servers?:unknown[]; plugins?:unknown[]; skills?:unknown[]; slash_commands?:unknown[];
  // stream_event
  event?:{type?:string; content_block?:ContentBlock; delta?:{type?:string; text?:string}};
  // assistant
  message?:{model?:string; content?:ContentBlock[]};
  // result
  is_error?:boolean; result?:string; stop_reason?:string|null; api_error_status?:number|null;
  usage?:{input_tokens?:unknown; output_tokens?:unknown; cache_read_input_tokens?:unknown; cache_creation_input_tokens?:unknown};
}
export interface ClaudeChatOptions {
  /** A bounded role deadline; injectable for short deterministic tests. */
  timeoutMs?:number;
}
function turnFailure(role:string,model:string,code?:string,status?:number|null):AppError {
  if(code==='authentication_failed'||status===401||status===403)return new AppError(502,`${role}未完成：Claude Code 登入已失效，請在伺服器執行 claude auth login 後重新整理。`);
  if(code==='rate_limit'||status===429)return new AppError(429,`${role}未完成：Claude 帳號用量或速率已達上限，請稍後重試或查看 Claude 用量。`);
  if(code==='billing_error')return new AppError(429,`${role}未完成：Claude 帳號方案或額度目前無法使用 ${model}，請確認訂閱方案。`);
  if(code==='invalid_request'||status===400||status===404)return new AppError(502,`${role}未完成：Claude 拒絕本次請求。請確認帳號方案與 Claude Code 版本支援 ${model} 與所選 effort。`);
  if(code==='max_output_tokens')return new AppError(502,`${role}未完成：回覆超過單次輸出上限，請縮短來源或聚焦需要學習的內容。`);
  if(code==='server_error'||(status!=null&&status>=500))return new AppError(502,`${role}未完成：Claude 服務暫時無法回應或連線中斷，尚未取得完整回覆。`);
  return new AppError(502,`${role}未完成：未收到成功結束的完整教學回覆，尚未儲存筆記。`);
}
export function createClaudeChat(settings:ProviderSettings,model:ProviderModel,cli:ClaudeCli,options:ClaudeChatOptions={}):ChatCall{
  if(!model.speeds.some(option=>option.id===settings.speed && option.available))throw new AppError(400,'這個模型尚未提供所選速度。');
  const effort=settings.effort==='default'?model.defaultEffort:settings.effort;
  if(!model.efforts.some(option=>option.id===effort))throw new AppError(400,'這個模型不支援所選 effort。');
  const timeoutMs=options.timeoutMs??900_000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>900_000)throw new AppError(500,'Claude 教學階段期限設定無效。');
  return async(role,instruction,data,signal,onProgress,images=[])=>{
    signal.throwIfAborted();
    const input=JSON.stringify(data);
    if(input.length+instruction.length+cliBoundary.length>100_000)throw new AppError(413,'這份內容超過單次模型輸入限制，請縮短內容。');
    const deadline=new AbortController();
    const duration=timeoutMs>=60_000?`${timeoutMs/60_000} 分鐘`:`${timeoutMs} 毫秒`;
    const timeout=setTimeout(()=>deadline.abort(new AppError(504,`${role}使用 ${model.id}（effort：${effort}、速度：${settings.speed}）超過本階段 ${duration} 上限，已停止等待；尚未儲存不完整筆記。`)),timeoutMs);
    const runSignal=AbortSignal.any([signal,deadline.signal]);
    // Progress contains observation metadata only. Never forward reasoning,
    // partial JSON, error details or account information.
    let phase:ChatProgress['phase']='connecting';
    let outputChars=0;
    const progress=(next:ChatProgress['phase'])=>{
      phase=next;
      try{onProgress?.({phase,outputChars});}catch{/* A UI listener cannot terminate inference. */}
    };
    let initialized=false;
    let failure:string|undefined;
    let result:ClaudeEvent|undefined;
    const isolationFailure=()=>new AppError(502,'Claude Code 未套用指定模型或隔離設定，教學工作已停止。');
    const actionFailure=()=>new AppError(502,'Claude Code 嘗試執行教學以外的動作，工作已停止。');
    const handle=(line:string)=>{
      let event:ClaudeEvent;
      try{event=JSON.parse(line) as ClaudeEvent;}catch{throw new AppError(502,'Claude Code 通訊格式不正確。');}
      if(event.type==='system'){
        if(event.subtype==='init'){
          const empty=(value:unknown)=>Array.isArray(value)&&value.length===0;
          // Safe mode still lists plugins bundled inside the CLI itself; any
          // user-installed or directory plugin stops the work.
          const bundled=Array.isArray(event.plugins)&&event.plugins.every(plugin=>{
            const item=plugin as {path?:unknown;source?:unknown};
            return item.path==='builtin'&&typeof item.source==='string'&&item.source.endsWith('@builtin');
          });
          if(event.model!==model.id||event.permissionMode!=='dontAsk'||(event.fast_mode_state!==undefined&&event.fast_mode_state!=='off')
            ||!empty(event.tools)||!empty(event.mcp_servers)||!bundled||!empty(event.skills)||!empty(event.slash_commands))throw isolationFailure();
          initialized=true;
        }else if(event.subtype==='api_retry'){failure=event.error||failure;progress('connecting');}
        return;
      }
      // Every model event must follow a verified init event.
      if(!initialized && ['stream_event','assistant','user','result'].includes(event.type||''))throw isolationFailure();
      if(event.type==='stream_event'){
        const stream=event.event;
        if(stream?.type==='message_start')progress(phase==='writing'?'writing':'thinking');
        if(stream?.type==='content_block_start'){
          if(!textBlocks.has(stream.content_block?.type||''))throw actionFailure();
          progress(stream.content_block?.type==='text'?'writing':phase==='writing'?'writing':'thinking');
        }
        if(stream?.type==='content_block_delta'){
          if(stream.delta?.type==='text_delta'&&typeof stream.delta.text==='string'){outputChars+=stream.delta.text.length;progress('writing');}
          else if(stream.delta?.type!=='thinking_delta'&&stream.delta?.type!=='signature_delta')throw actionFailure();
          else progress(phase==='writing'?'writing':'thinking');
        }
        return;
      }
      if(event.type==='assistant'){
        // Errors arrive as a synthetic assistant message; keep only the code.
        if(event.error){failure=event.error;return;}
        if(event.message?.model!==model.id)throw new AppError(502,`${role}收到其他模型（非 ${model.id}）的回覆；為保留你選擇的模型，已停止本次工作。`);
        if(event.message.content?.some(block=>!textBlocks.has(block.type||'')))throw actionFailure();
        return;
      }
      // Tool results come back as user messages; no tools are enabled.
      if(event.type==='user')throw actionFailure();
      if(event.type==='result')result=event;
    };
    let cwd:string|undefined;
    progress('connecting');
    try{
      cwd=await mkdtemp(join(tmpdir(),'bell-claude-'));
      const promptPath=join(cwd,'system-prompt.txt');
      await writeFile(promptPath,`${cliBoundary}\n代理角色：${role}\n${instruction}`,{mode:0o600});
      const args=[...claudeArguments,'--model',model.id,'--system-prompt-file',promptPath,...(effort==='default'?[]:['--effort',effort])];
      // Page images need a structured user message; plain text stays on the text input path.
      const message=images.length?`${JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:input},...images.flatMap(image=>[
        {type:'text',text:image.label},{type:'image',source:{type:'base64',media_type:image.mimeType,data:image.data}},
      ])]}})}\n`:input;
      if(images.length)args.push('--input-format','stream-json');
      await cli.run(args,{cwd,input:message,signal:runSignal,onLine:handle});
      // Anthropic reports uncached, cache-read and cache-write input separately; sum them so
      // inputTokens means all input, as it does for Codex and the compatible API.
      const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
      const usage=result?.usage&&usageOf({inputTokens:result.usage.input_tokens===undefined?undefined:count(result.usage.input_tokens)+count(result.usage.cache_read_input_tokens)+count(result.usage.cache_creation_input_tokens),
        cachedInputTokens:result.usage.cache_read_input_tokens,cacheWriteTokens:result.usage.cache_creation_input_tokens,outputTokens:result.usage.output_tokens});
      if(usage)try{onProgress?.({phase,outputChars,usage});}catch{/* A UI listener cannot terminate inference. */}
      if(!result)throw failure?turnFailure(role,model.id,failure):new AppError(502,`${role}已結束，但 Claude Code 未回傳完整教學內容，尚未儲存筆記。`);
      if(result.stop_reason==='refusal')throw new AppError(502,`${role}未完成：Claude 依安全政策拒絕處理這段內容，未儲存筆記。可改用其他模型或調整來源後重試。`);
      if(result.is_error||result.subtype!=='success'){
        // A model newer than the installed CLI is rejected before inference; the
        // message text is matched only to choose this hint, never shown.
        if(/or newer is required|claude update/i.test(result.result||''))throw new AppError(502,`${role}未完成：本機 Claude Code 版本不支援 ${model.id}。請在伺服器執行 claude update 後重試。`);
        throw turnFailure(role,model.id,failure,result.api_error_status);
      }
      if(result.stop_reason==='max_tokens')throw turnFailure(role,model.id,'max_output_tokens');
      const final=result.result;
      if(!final)throw new AppError(502,`${role}已結束，但 Claude Code 未回傳完整教學內容，尚未儲存筆記。`);
      if(final.length>700_000)throw new AppError(502,'Claude Code 回覆過大。');
      try{return JSON.parse(final.replace(/^\s*```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));}
      catch{throw new AppError(502,'Claude 回覆未符合 JSON 結構，請重試。');}
    }finally{
      clearTimeout(timeout);
      if(cwd)await rm(cwd,{recursive:true,force:true});
    }
  };
}
