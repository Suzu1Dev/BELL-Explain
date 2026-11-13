import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatProgress } from './ai.js';
import { AppError } from './errors.js';
import { claudeArguments, claudeCli, claudeEnvironment, claudeModels, createClaudeChat, discoverClaude, type ClaudeCli, type ClaudeRunOptions } from './claude.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { ProviderService } from './provider-router.js';
import type { ProviderInfo, ProviderSettings } from '../shared/settings.js';

const opus=claudeModels.find(model=>model.id==='claude-opus-5-5')!;
const haiku=claudeModels.find(model=>model.id==='claude-haiku-4-5')!;
const settings:ProviderSettings={provider:'claude',model:opus.id,effort:'high',speed:'default'};
const init=(override:Record<string,unknown>={})=>JSON.stringify({type:'system',subtype:'init',model:opus.id,permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],slash_commands:[],agents:['general-purpose'],fast_mode_state:'off',...override});
const block=(type:string)=>JSON.stringify({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type}}});
const delta=(text:string)=>JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
const assistant=(text:string,model=opus.id)=>JSON.stringify({type:'assistant',message:{model,content:[{type:'text',text}]}});
const result=(text:string,override:Record<string,unknown>={})=>JSON.stringify({type:'result',subtype:'success',is_error:false,result:text,stop_reason:'end_turn',...override});
const success=(text='{"ok":true}')=>[init(),block('text'),delta(text),assistant(text),result(text)];

interface Call { args:string[]; cwd:string; input?:string; prompt?:string; }
class FakeCli implements ClaudeCli {
  calls:Call[]=[];
  constructor(public lines:string[]=success(),private hold?:(options:ClaudeRunOptions)=>Promise<number|null>){}
  async run(args:string[],options:ClaudeRunOptions){
    const call:Call={args,cwd:options.cwd,input:options.input};this.calls.push(call);
    const prompt=args.indexOf('--system-prompt-file');
    if(prompt>=0)call.prompt=await readFile(args[prompt+1],'utf8');
    for(const line of this.lines)options.onLine(line);
    return this.hold?this.hold(options):0;
  }
}
const run=(chat:ReturnType<typeof createClaudeChat>,data:unknown={code:'const value=1'})=>chat('Teacher','Return JSON',data,new AbortController().signal);

test('Claude discovery reads login status without generating a turn or exposing account details',async()=>{
  const cli=new FakeCli(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private@example.test',orgId:'org-secret',subscriptionType:'pro'},null,2).split('\n'));
  const info=await discoverClaude(cli,new AbortController().signal);
  assert.deepEqual(cli.calls[0].args,['auth','status','--json']);
  assert.equal(info.available,true);assert.equal(info.authenticated,true);
  assert.deepEqual(info.models.filter(model=>model.isDefault).map(model=>model.id),['claude-opus-5-5']);
  assert.match(info.message,/Pro 方案/);
  assert.equal(/private@example|org-secret/.test(JSON.stringify(info)),false);
});
test('missing Claude login returns actionable unavailable state',async()=>{
  const info=await discoverClaude(new FakeCli([JSON.stringify({loggedIn:false,authMethod:'none'})]),new AbortController().signal);
  assert.equal(info.available,false);assert.equal(info.authenticated,false);assert.deepEqual(info.models,[]);
  assert.match(info.message,/claude auth login/);
  await assert.rejects(()=>discoverClaude(new FakeCli(['not json']),new AbortController().signal),/無法讀取 Claude Code 登入狀態/);
});
test('Claude models advertise only standard speed and per-model effort',()=>{
  for(const model of claudeModels)assert.deepEqual(model.speeds.map(item=>[item.id,item.available]),[['default',true],['fast',false],['ultrafast',false]]);
  assert.equal(opus.defaultEffort,'medium');
  assert.deepEqual(opus.efforts.map(item=>item.id),['low','medium','high','xhigh','max']);
  assert.deepEqual(haiku.efforts.map(item=>item.id),['default']);
  assert.throws(()=>createClaudeChat({...settings,speed:'fast'},opus,new FakeCli()),/速度/);
  assert.throws(()=>createClaudeChat({...settings,effort:'ultra'},opus,new FakeCli()),/effort/);
  assert.throws(()=>createClaudeChat({...settings,model:haiku.id,effort:'high'},haiku,new FakeCli()),/effort/);
});
test('Claude generation runs an isolated print session with exact model, effort and stdin data',async()=>{
  const cli=new FakeCli(success('```json\n{"ok":true}\n```'));
  assert.deepEqual(await run(createClaudeChat(settings,opus,cli),{code:'const value=1'}),{ok:true});
  const call=cli.calls[0];
  assert.deepEqual(call.args.slice(0,claudeArguments.length),claudeArguments);
  for(const flag of ['--safe-mode','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'])assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf('--tools')+1],'');
  assert.equal(call.args[call.args.indexOf('--permission-mode')+1],'dontAsk');
  assert.equal(call.args[call.args.indexOf('--model')+1],'claude-opus-5-5');
  assert.equal(call.args[call.args.indexOf('--effort')+1],'high');
  assert.equal(call.args.includes('--bare'),false);
  // Source data travels on stdin, never in arguments or the system prompt.
  assert.equal(call.input,JSON.stringify({code:'const value=1'}));
  assert.equal(call.args.some(arg=>arg.includes('const value')),false);
  assert.match(call.prompt!,/代理角色：Teacher\nReturn JSON$/);assert.doesNotMatch(call.prompt!,/const value/);
  await assert.rejects(()=>access(call.cwd),'temporary prompt directory is removed');
});
test('default effort is passed explicitly; Haiku runs without an effort flag',async()=>{
  const cli=new FakeCli();
  await run(createClaudeChat({...settings,effort:'default'},opus,cli));
  assert.equal(cli.calls[0].args[cli.calls[0].args.indexOf('--effort')+1],'medium');
  const fast=new FakeCli([init({model:haiku.id}),assistant('{"ok":true}',haiku.id),result('{"ok":true}')]);
  await run(createClaudeChat({...settings,model:haiku.id,effort:'default'},haiku,fast));
  assert.equal(fast.calls[0].args.includes('--effort'),false);
});
test('Claude stops when the CLI reports a different model or weaker isolation',async()=>{
  for(const override of [{model:'claude-sonnet-5-5'},{tools:['Bash']},{mcp_servers:[{name:'x'}]},{plugins:[{name:'p'}]},{plugins:[{name:'p',path:'/home/u/plugin',source:'p@builtin'}]},{plugins:[{name:'p',path:'builtin',source:'p@marketplace'}]},{plugins:undefined},{skills:['s']},{slash_commands:['/x']},{permissionMode:'bypassPermissions'},{fast_mode_state:'on'},{tools:undefined}]){
    const cli=new FakeCli([init(override),...success().slice(1)]);
    await assert.rejects(()=>run(createClaudeChat(settings,opus,cli)),/隔離設定/,JSON.stringify(override));
  }
  await assert.rejects(()=>run(createClaudeChat(settings,opus,new FakeCli(success().slice(1)))),/隔離設定/,'model output before init');
});
test('page images switch Claude Code to a structured stream-json user message',async()=>{
  const cli=new FakeCli();
  await createClaudeChat(settings,opus,cli)('Teacher','Return JSON',{a:1},new AbortController().signal,undefined,[{mimeType:'image/png',data:'AAAA',label:'第 4 頁影像'}]);
  const call=cli.calls[0];
  assert.equal(call.args[call.args.indexOf('--input-format')+1],'stream-json');
  assert.deepEqual(JSON.parse(call.input!),{type:'user',message:{role:'user',content:[
    {type:'text',text:'{"a":1}'},{type:'text',text:'第 4 頁影像'},{type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}},
  ]}});
  const text=new FakeCli();
  await run(createClaudeChat(settings,opus,text));
  assert.equal(text.calls[0].args.includes('--input-format'),false);
});
test('plugins bundled with the CLI are accepted under safe mode',async()=>{
  // Claude Code 2.1.292 lists these even with --safe-mode.
  const plugins=[{name:'cc-plugin-agents-md',path:'builtin',source:'cc-plugin-agents-md@builtin'},{name:'cc-plugin-plugin-authoring',path:'builtin',source:'cc-plugin-plugin-authoring@builtin'}];
  const lines=[JSON.stringify({type:'system',subtype:'ui_invalidate',event:'ui.render'}),init({plugins}),...success().slice(1)];
  assert.deepEqual(await run(createClaudeChat(settings,opus,new FakeCli(lines))),{ok:true});
});
test('tool use, tool results and model reroutes never return lesson data',async()=>{
  for(const lines of [
    [init(),block('tool_use'),result('{"ok":true}')],
    [init(),JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'input_json_delta',partial_json:'{}'}}}),result('{"ok":true}')],
    [init(),JSON.stringify({type:'assistant',message:{model:opus.id,content:[{type:'tool_use',name:'Bash'}]}}),result('{"ok":true}')],
    [init(),JSON.stringify({type:'user',message:{content:[{type:'tool_result'}]}}),result('{"ok":true}')],
  ])await assert.rejects(()=>run(createClaudeChat(settings,opus,new FakeCli(lines))),/教學以外的動作/);
  await assert.rejects(()=>run(createClaudeChat(settings,opus,new FakeCli([init(),assistant('{"ok":true}','claude-haiku-4-5'),result('{"ok":true}')]))),/其他模型/);
});
test('Claude failures map to actionable messages without leaking CLI output',async()=>{
  // Shape observed from Claude Code 2.1 when its stored OAuth session expired.
  const expired=[init(),JSON.stringify({type:'system',subtype:'api_retry',attempt:1,error_status:401,error:'authentication_failed'}),
    JSON.stringify({type:'assistant',message:{model:'<synthetic>',content:[{type:'text',text:'Failed to authenticate: PRIVATE_DETAIL'}]},error:'authentication_failed'}),
    result('Failed to authenticate: PRIVATE_DETAIL',{is_error:true,stop_reason:'stop_sequence',api_error_status:null})];
  const cases:Array<[string[],RegExp,number]>=[
    [expired,/claude auth login/,502],
    [[init(),JSON.stringify({type:'assistant',message:{model:'<synthetic>',content:[]},error:'rate_limit'}),result('PRIVATE_DETAIL',{is_error:true})],/用量或速率/,429],
    [[init(),result('PRIVATE_DETAIL',{is_error:true,api_error_status:529})],/暫時無法回應/,502],
    [[init(),result('API Error: 400 Claude Code 2.1.208 does not support this model; version 2.1.280 or newer is required. PRIVATE_DETAIL',{is_error:true,api_error_status:400})],/claude update/,502],
    [[init(),result('PRIVATE_DETAIL',{is_error:true,api_error_status:400})],/方案與 Claude Code 版本/,502],
    [[init(),assistant('PRIVATE_DETAIL'),result('PRIVATE_DETAIL',{stop_reason:'refusal'})],/安全政策/,502],
    [[init(),assistant('{"ok":'),result('{"ok":',{stop_reason:'max_tokens'})],/輸出上限/,502],
    [[init(),assistant('not json'),result('not json')],/JSON/,502],
    [[init(),assistant('{"ok":true}')],/未回傳完整/,502],
    [['{broken'],/通訊格式/,502],
  ];
  for(const [lines,pattern,status] of cases){
    const error=await run(createClaudeChat(settings,opus,new FakeCli(lines))).then(()=>undefined,error=>error);
    assert.ok(error instanceof AppError,String(pattern));assert.match(error.message,pattern);assert.equal(error.status,status);
    assert.doesNotMatch(error.message,/PRIVATE_DETAIL/);
  }
});
test('Claude progress reports metadata only and counts streamed answer characters',async()=>{
  const events:ChatProgress[]=[];
  const lines=[init(),JSON.stringify({type:'stream_event',event:{type:'message_start'}}),block('thinking'),
    JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'PRIVATE_REASONING'}}}),
    block('text'),delta('{"ok":'),delta('true}'),assistant('{"ok":true}'),result('{"ok":true}')];
  await createClaudeChat(settings,opus,new FakeCli(lines))('Teacher','Return JSON',{},new AbortController().signal,progress=>events.push(progress));
  assert.deepEqual(events.map(item=>item.phase).filter((phase,index,all)=>phase!==all[index-1]),['connecting','thinking','writing']);
  assert.equal(events.at(-1)?.outputChars,11);
  assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'),false);
});
test('Claude reports token usage from the result event and nothing else',async()=>{
  const events:ChatProgress[]=[];
  // Anthropic counts uncached, cache-read and cache-write input separately.
  const lines=[init(),assistant('{"ok":true}'),result('{"ok":true}',{usage:{input_tokens:5,output_tokens:640,cache_read_input_tokens:4200,cache_creation_input_tokens:25000,service_tier:'standard'}})];
  await createClaudeChat(settings,opus,new FakeCli(lines))('Teacher','Return JSON',{},new AbortController().signal,progress=>events.push(progress));
  assert.deepEqual(events.at(-1)?.usage,{inputTokens:29205,cachedInputTokens:4200,cacheWriteTokens:25000,outputTokens:640});
});
test('Claude hard role deadline and user cancellation stay distinct and clean up',async()=>{
  // The abort can land before the CLI starts (while the prompt file is written): reject at once then.
  const hold=(options:ClaudeRunOptions)=>new Promise<number|null>((_resolve,reject)=>{
    if(options.signal.aborted){reject(options.signal.reason);return;}
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
  });
  const timed=new FakeCli([init()],hold);
  const timeout=await createClaudeChat(settings,opus,timed,{timeoutMs:20})('Teacher','Return JSON',{},new AbortController().signal).then(()=>undefined,error=>error);
  assert.ok(timeout instanceof AppError);assert.equal(timeout.status,504);assert.match(timeout.message,/claude-opus-5-5.*20 毫秒/);
  await assert.rejects(()=>access(timed.calls[0].cwd));
  const user=new AbortController();
  const cancelled=createClaudeChat(settings,opus,new FakeCli([init()],hold))('Teacher','Return JSON',{},user.signal);
  setTimeout(()=>user.abort(),5);
  await assert.rejects(cancelled,(error:Error)=>error.name==='AbortError');
});
test('Claude environment keeps login lookup and drops BELL secrets and parent sessions',()=>{
  const env=claudeEnvironment({HOME:'/home/u',PATH:'/bin',LANG:'C.UTF-8',CLAUDE_CONFIG_DIR:'/cfg',AI_API_KEY:'secret',EMBEDDING_API_KEY:'secret',BELL_SYNC_TOKEN:'secret',ANTHROPIC_BASE_URL:'http://proxy',CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:'parent'});
  assert.deepEqual(env,{HOME:'/home/u',PATH:'/bin',LANG:'C.UTF-8',CLAUDE_CONFIG_DIR:'/cfg',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
});
test('Claude CLI transport splits stdout lines, writes stdin and kills a cancelled process',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bell-claude-cli-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'claude');
  await writeFile(script,`#!/usr/bin/env node
let input='';process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  if(process.argv.includes('--hang')){process.stdout.write('{"type":"system"');setInterval(()=>{},1000);return;}
  process.stdout.write('{"type":"a","input":'+JSON.stringify(input)+'}\\n{"type":');
  setTimeout(()=>{process.stdout.write('"b","secret":'+JSON.stringify(process.env.AI_API_KEY??null)+'}\\n');process.exit(3);},20);
});`);
  await chmod(script,0o700);
  const previous=process.env.AI_API_KEY;process.env.AI_API_KEY='server-only-secret';
  t.after(()=>{if(previous===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=previous;});
  const lines:string[]=[];
  const code=await claudeCli(script).run([],{cwd:dir,input:'payload',signal:new AbortController().signal,onLine:line=>lines.push(line)});
  assert.equal(code,3);
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[{type:'a',input:'payload'},{type:'b',secret:null}]);
  const controller=new AbortController();const started=Date.now();
  const hanging=claudeCli(script).run(['--hang'],{cwd:dir,signal:controller.signal,onLine:()=>{}});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(hanging,(error:Error)=>error.name==='AbortError');
  assert.ok(Date.now()-started<2500);
  await assert.rejects(()=>claudeCli(join(dir,'missing')).run([],{cwd:dir,signal:new AbortController().signal,onLine:()=>{}}),/無法啟動 Claude Code CLI/);
});
test('provider service lists Claude Code and routes saved Claude settings to the CLI',async()=>{
  const store=new ProviderSettingsStore(':memory:');
  const codex:ProviderInfo={id:'codex',name:'Codex',available:false,authenticated:false,message:'offline',models:[]};
  const cli=new FakeCli();
  const agy:ProviderInfo={id:'antigravity',name:'Antigravity',available:false,authenticated:false,message:'offline',models:[]};
  const service=new ProviderService({store,discover:async()=>codex,claudeCli:cli,discoverClaude:async()=>({id:'claude',name:'Claude Code',available:true,authenticated:true,message:'ready',models:structuredClone(claudeModels)}),discoverAntigravity:async()=>agy});
  try{
    assert.deepEqual((await service.catalog()).providers.map(item=>item.id),['codex','claude','antigravity','api']);
    const snapshot=await service.update({provider:'claude',model:'claude-opus-5-5',effort:'default',speed:'default'});
    assert.equal(snapshot.settings.provider,'claude');assert.equal((await service.status()).configured,true);
    await assert.rejects(()=>service.update({speed:'fast'}));
    assert.deepEqual(await (await service.createChat())('Teacher','Return JSON',{},new AbortController().signal),{ok:true});
    assert.equal(cli.calls[0].args[cli.calls[0].args.indexOf('--model')+1],'claude-opus-5-5');
  }finally{store.close();}
});
