import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatProgress } from './ai.js';
import { AppError } from './errors.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexChat, discoverCodex, normalizeCodexModel, codexArguments, codexRpcFactory, type CodexRpc } from './codex.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { ProviderService } from './provider-router.js';
import type { ProviderInfo, ProviderSettings } from '../shared/settings.js';

const rawModel={model:'test-model',displayName:'Test model',description:'Fixture model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'},{reasoningEffort:'medium',description:'Medium'}],serviceTiers:[{id:'priority',name:'Fast',description:'Higher usage'}]};
const model=normalizeCodexModel(rawModel);
const settings:ProviderSettings={provider:'codex',model:model.id,effort:'low',speed:'fast',ponytailMode:'full'};
const info:ProviderInfo={id:'codex',name:'Codex',available:true,authenticated:true,message:'Connected',models:[model]};
const claudeOffline:ProviderInfo={id:'claude',name:'Claude Code',available:false,authenticated:false,message:'offline',models:[]};
const agyOffline:ProviderInfo={id:'antigravity',name:'Antigravity',available:false,authenticated:false,message:'offline',models:[]};
class FakeRpc implements CodexRpc {
  cwd='/tmp/bell-empty-test';
  requests:Array<{method:string;params:Record<string,unknown>}>=[];
  closed=false;
  closeCount=0;
  autoComplete=true;
  listener?:(event:{method:string;params?:Record<string,unknown>})=>void;
  onError?:(error:Error)=>void;
  items:Array<{type:string;id?:string;text?:string;phase?:string}>=[{type:'agentMessage',id:'answer',phase:'final_answer',text:'{"ok":true}'}];
  status='completed';
  request<T>(method:string,input:unknown):Promise<T>{
    const params=input as Record<string,unknown>;this.requests.push({method,params});
    let value:unknown={};
    if(method==='account/read')value={account:{type:'chatgpt'},requiresOpenaiAuth:true};
    if(method==='model/list')value={data:[rawModel],nextCursor:null};
    if(method==='config/read')value={config:{mcp_servers:{example:{enabled:true}}}};
    if(method==='thread/start')value={thread:{id:'thread-1'},model:model.id,serviceTier:params.serviceTier,sandbox:{type:'readOnly'},instructionSources:[]};
    if(method==='turn/start'){
      value={turn:{id:'turn-1'}};
      if(this.autoComplete)queueMicrotask(()=>{
        for(const item of this.items){
          this.listener?.({method:'item/started',params:{threadId:'thread-1',item}});
          this.listener?.({method:'item/completed',params:{threadId:'thread-1',item}});
        }
        this.listener?.({method:'turn/completed',params:{threadId:'thread-1',turn:{status:this.status}}});
      });
    }
    return Promise.resolve(value as T);
  }
  subscribe(listener:FakeRpc['listener'],onError:FakeRpc['onError']):()=>void{this.listener=listener;this.onError=onError;return()=>{this.listener=undefined;this.onError=undefined;};}
  async close(){this.closed=true;this.closeCount++;}
}

test('speed options use exact advertised IDs and never invent Ultrafast',()=>{
  assert.deepEqual(model.speeds.map(item=>[item.id,item.available,item.serviceTier]),[['default',true,'default'],['fast',true,'priority'],['ultrafast',false,undefined]]);
  const ultra=normalizeCodexModel({...rawModel,serviceTiers:[{id:'provider-tier-42',name:'Ultrafast',description:'Advertised account tier'}]});
  assert.equal(ultra.speeds.find(item=>item.id==='ultrafast')?.serviceTier,'provider-tier-42');
  assert.equal(ultra.speeds.find(item=>item.id==='fast')?.available,false);
});
test('Codex discovery reads account and catalog without generating a turn',async()=>{
  const rpc=new FakeRpc();
  const catalog=await discoverCodex(async()=>rpc,new AbortController().signal);
  assert.equal(catalog.authenticated,true);assert.equal(catalog.models[0].id,model.id);
  assert.deepEqual(rpc.requests.map(item=>item.method),['account/read','model/list']);assert.equal(rpc.closed,true);
  assert.equal(JSON.stringify(catalog).includes('token'),false);
});
test('Codex discovery follows pagination and excludes hidden or specialized access-only models',async()=>{
  const rpc=new FakeRpc();const base=rpc.request.bind(rpc);let page=0;
  rpc.request=async<T>(method:string,params:unknown)=>{
    if(method==='model/list')return (++page===1?{data:[rawModel],nextCursor:'next'}:{data:[{...rawModel,model:'special',availableAccessPrograms:{cyber:['daybreakBlue']}},{...rawModel,model:'hidden',hidden:true}],nextCursor:null}) as T;
    return base<T>(method,params);
  };
  const catalog=await discoverCodex(async()=>rpc,new AbortController().signal);
  assert.equal(page,2);assert.deepEqual(catalog.models.map(item=>item.id),['test-model']);
});
test('missing Codex login returns actionable unavailable state',async()=>{
  const rpc=new FakeRpc();rpc.request=async<T>()=>({account:null,requiresOpenaiAuth:true}) as T;
  const catalog=await discoverCodex(async()=>rpc,new AbortController().signal);
  assert.equal(catalog.available,false);assert.equal(catalog.authenticated,false);assert.match(catalog.message,/codex login/);assert.equal(rpc.closed,true);
});
test('provider settings persist across SQLite reopen',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bell-provider-test-'));const path=join(dir,'settings.sqlite');
  try{
    const initial=new ProviderSettingsStore(path);initial.save(settings);initial.close();
    const reopened=new ProviderSettingsStore(path);assert.deepEqual(reopened.get(),settings);reopened.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('settings reject unsupported model, effort, speed and fields before persistence',async()=>{
  const store=new ProviderSettingsStore(':memory:');
  const service=new ProviderService({store,discover:async()=>info,discoverClaude:async()=>claudeOffline,discoverAntigravity:async()=>agyOffline});
  try{
    assert.equal((await service.settings()).model,model.id);
    assert.equal((await service.settings()).ponytailMode,'full');
    await service.update(settings);
    for(const patch of [{speed:'ultrafast'},{effort:'ultra'},{model:'invented-model'},{ponytailMode:'invalid'},{apiKey:'secret'}])await assert.rejects(()=>service.update(patch));
    assert.deepEqual(store.get(),settings);
    assert.equal((await service.status()).configured,true);
  }finally{store.close();}
});
test('API compatibility preserves existing configured model without pretending speed support',async()=>{
  const store=new ProviderSettingsStore(':memory:',{provider:'api'});
  const service=new ProviderService({store,apiConfig:{apiKey:'server-only-secret',baseUrl:'https://example.test/v1',model:'api-model'},discover:async()=>({...info,available:false}),discoverClaude:async()=>claudeOffline,discoverAntigravity:async()=>agyOffline});
  try{
    const snapshot=await service.snapshot();
    assert.equal(snapshot.settings.model,'api-model');assert.equal((await service.status()).configured,true);
    assert.equal(JSON.stringify(snapshot).includes('server-only-secret'),false);
    await assert.rejects(()=>service.update({speed:'fast'}));
    await assert.rejects(()=>service.update({effort:'high'}));
  }finally{store.close();}
});
test('Codex generation uses isolated ephemeral readonly session, exact tier and effort',async()=>{
  const rpc=new FakeRpc();const chat=createCodexChat(settings,model,async()=>rpc);
  const result=await chat('Teacher','Return JSON',{code:'const value=1'},new AbortController().signal);
  assert.deepEqual(result,{ok:true});assert.equal(rpc.closed,true);
  const thread=rpc.requests.find(item=>item.method==='thread/start')!.params;
  const turn=rpc.requests.find(item=>item.method==='turn/start')!.params;
  assert.equal(thread.ephemeral,true);assert.equal(thread.sandbox,'read-only');
  assert.deepEqual(thread.environments,[]);assert.deepEqual(thread.dynamicTools,[]);
  assert.deepEqual(thread.runtimeWorkspaceRoots,[]);assert.equal(thread.approvalPolicy,'never');
  assert.equal((thread.config as Record<string,unknown>)['mcp_servers.example.enabled'],false);
  assert.equal(thread.serviceTier,'priority');assert.equal(turn.serviceTierForTurn,'priority');assert.equal(turn.effort,'low');
  assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});
  for(const setting of ['features.hooks=false','features.plugins=false','features.shell_tool=false','features.apps=false','features.multi_agent=false'])assert.ok(codexArguments.includes(setting));
});
test('Codex reports the thread token usage once the turn completes',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;
  const events:ChatProgress[]=[];
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal,progress=>events.push(progress));
  while(!rpc.listener)await new Promise(resolve=>setTimeout(resolve,1));
  await new Promise(resolve=>setTimeout(resolve,5));
  rpc.listener({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'turn-1',tokenUsage:{total:{inputTokens:900,cachedInputTokens:100,outputTokens:300,reasoningOutputTokens:50,totalTokens:1200},last:{}}}});
  rpc.listener({method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',id:'a',phase:'final_answer',text:'{"ok":true}'}}});
  rpc.listener({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});
  assert.deepEqual(await pending,{ok:true});
  assert.deepEqual(events.filter(event=>event.usage).map(event=>event.usage),[{inputTokens:900,cachedInputTokens:100,outputTokens:300,reasoningTokens:50}]);
});
test('Codex receives page images after the JSON data, each with its page label',async()=>{
  const rpc=new FakeRpc();
  await createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{a:1},new AbortController().signal,undefined,[{mimeType:'image/jpeg',data:'/9j/',label:'第 2 頁影像'}]);
  const turn=rpc.requests.find(item=>item.method==='turn/start')!.params;
  assert.deepEqual(turn.input,[{type:'text',text:'{"a":1}'},{type:'text',text:'第 2 頁影像'},{type:'image',url:'data:image/jpeg;base64,/9j/'}]);
});
test('default speed overrides any inherited account fast setting explicitly',async()=>{
  const rpc=new FakeRpc();await createCodexChat({...settings,speed:'default',effort:'default'},model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal);
  const turn=rpc.requests.find(item=>item.method==='turn/start')!.params;
  assert.equal(turn.serviceTierForTurn,'default');assert.equal(turn.effort,'medium');
});
test('tool invocation, invalid JSON and incomplete Codex turns never return lesson data',async()=>{
  for(const [items,status] of [
    [[{type:'commandExecution'}],'completed'],
    [[{type:'agentMessage',text:'not json'}],'completed'],
    [[{type:'agentMessage',text:'{"ok":true}'}],'failed'],
  ] as const){
    const rpc=new FakeRpc();rpc.items=[...items];rpc.status=status;
    await assert.rejects(()=>createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal));
    assert.equal(rpc.closed,true);
  }
});
test('missing Codex executable reports a useful error and cleans up transport',async()=>{
  await assert.rejects(()=>codexRpcFactory('/not-installed/bell-codex')(AbortSignal.timeout(3000)),/Codex CLI/);
});

async function advanceMicrotasks(){for(let index=0;index<20;index++)await Promise.resolve();}
function finishRpc(rpc:FakeRpc,text='{"ok":true}'){
  rpc.listener?.({method:'item/completed',params:{threadId:'thread-1',item:{id:'final',type:'agentMessage',phase:'final_answer',text}}});
  rpc.listener?.({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});
}
test('Codex progress reports metadata, excludes commentary/reasoning text and counts final deltas once',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;
  const events:ChatProgress[]=[];
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal,event=>events.push(event));
  await advanceMicrotasks();
  const emit=(method:string,params:Record<string,unknown>)=>rpc.listener?.({method,params:{threadId:'thread-1',...params}});
  emit('turn/started',{turn:{id:'turn-1'}});
  emit('item/reasoning/textDelta',{delta:'PRIVATE_REASONING_DO_NOT_FORWARD'});
  emit('item/started',{item:{id:'comment',type:'agentMessage',phase:'commentary'}});
  emit('item/agentMessage/delta',{itemId:'comment',delta:'COMMENTARY_DO_NOT_FORWARD'});
  emit('item/completed',{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'COMMENTARY_DO_NOT_FORWARD'}});
  assert.equal(events.at(-1)?.outputChars,0);
  emit('item/agentMessage/delta',{threadId:'another-thread',itemId:'wrong',delta:'ignore'});
  emit('item/started',{item:{id:'final',type:'agentMessage',phase:'final_answer'}});
  emit('item/agentMessage/delta',{itemId:'final',delta:'{"ok":'});
  assert.equal(events.at(-1)?.outputChars,6);
  emit('item/agentMessage/delta',{itemId:'final',delta:'true}'});
  finishRpc(rpc);
  assert.deepEqual(await pending,{ok:true});
  assert.equal(events.at(-1)?.outputChars,11);
  assert.ok(events.some(event=>event.phase==='connecting'));
  assert.ok(events.some(event=>event.phase==='thinking'));
  assert.ok(events.some(event=>event.phase==='writing'));
  assert.ok(events.every(event=>Object.keys(event).sort().join(',')==='outputChars,phase'));
  assert.ok(!JSON.stringify(events).includes('DO_NOT_FORWARD'));
  assert.equal(rpc.closeCount,1);
});
test('Codex keeps exact settings and remains active beyond the old five minute cutoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const rpc=new FakeRpc();rpc.autoComplete=false;
  let settled=false;
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal);
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  await advanceMicrotasks();
  assert.ok(rpc.requests.some(request=>request.method==='turn/start'));
  t.mock.timers.tick(300_001);
  await advanceMicrotasks();
  assert.equal(settled,false);assert.equal(rpc.closed,false);
  const turn=rpc.requests.find(request=>request.method==='turn/start')!.params;
  assert.equal(turn.model,settings.model);assert.equal(turn.effort,settings.effort);assert.equal(turn.serviceTierForTurn,'priority');
  finishRpc(rpc);assert.deepEqual(await pending,{ok:true});assert.equal(rpc.closeCount,1);
});
test('Codex hard role deadline is descriptive and closes an adapter that ignores abort',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const rpc=new FakeRpc();rpc.autoComplete=false;
  const pending=createCodexChat(settings,model,async()=>rpc,{timeoutMs:90})('教學代理','Return JSON',{},new AbortController().signal);
  const rejected=assert.rejects(pending,error=>error instanceof AppError&&error.status===504&&error.message.includes('教學代理')&&error.message.includes(model.id)&&error.message.includes('effort：low')&&error.message.includes('速度：fast')&&!error.message.includes('使用者取消'));
  await advanceMicrotasks();t.mock.timers.tick(90);
  await rejected;assert.equal(rpc.closeCount,1);assert.equal(rpc.listener,undefined);
});
test('Codex external user cancellation stays distinct from its hard deadline and cleans up',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;
  const controller=new AbortController();
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},controller.signal);
  const rejected=assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError'&&!(error instanceof AppError));
  await advanceMicrotasks();controller.abort();
  await rejected;assert.equal(rpc.closeCount,1);assert.equal(rpc.listener,undefined);
});
test('Codex abort while factory ignores the signal returns immediately and closes a late client',async()=>{
  const rpc=new FakeRpc();let resolveFactory!:(rpc:CodexRpc)=>void;
  const factoryResult=new Promise<CodexRpc>(resolve=>{resolveFactory=resolve;});
  const controller=new AbortController();
  const pending=createCodexChat(settings,model,async()=>factoryResult)('Teacher','Return JSON',{},controller.signal);
  const rejected=assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');
  controller.abort();await rejected;assert.equal(rpc.closeCount,0);
  resolveFactory(rpc);await advanceMicrotasks();assert.equal(rpc.closeCount,1);
});
test('Codex hard deadline also bounds a setup RPC that ignores cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const rpc=new FakeRpc();rpc.request=async<T>()=>new Promise<T>(()=>{});
  const pending=createCodexChat(settings,model,async()=>rpc,{timeoutMs:50})('分析代理','Return JSON',{},new AbortController().signal);
  const rejected=assert.rejects(pending,error=>error instanceof AppError&&error.status===504);
  await advanceMicrotasks();t.mock.timers.tick(50);await rejected;assert.equal(rpc.closeCount,1);
});
test('Codex retries retain progress without exposing provider error details',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;const progress:ChatProgress[]=[];
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal,event=>progress.push(event));
  await advanceMicrotasks();
  rpc.listener?.({method:'error',params:{threadId:'thread-1',willRetry:true,error:{message:'PRIVATE_PROVIDER_DIAGNOSTIC'}}});
  assert.equal(progress.at(-1)?.phase,'connecting');
  finishRpc(rpc);assert.deepEqual(await pending,{ok:true});
  assert.ok(!JSON.stringify(progress).includes('PRIVATE_PROVIDER_DIAGNOSTIC'));
});
test('Codex reports incomplete and interrupted turns without calling them user cancellations',async()=>{
  for(const status of ['completed','interrupted']){
    const rpc=new FakeRpc();rpc.items=[];rpc.status=status;
    await assert.rejects(()=>createCodexChat(settings,model,async()=>rpc)('教學代理','Return JSON',{},new AbortController().signal),error=>error instanceof AppError&&error.status===502&&error.message.includes('教學代理')&&!error.message.includes('使用者取消'));
    assert.equal(rpc.closeCount,1);
  }
});
test('Codex provider model reroute is rejected rather than silently changing the selected model',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;
  const pending=createCodexChat(settings,model,async()=>rpc)('Teacher','Return JSON',{},new AbortController().signal);
  const rejected=assert.rejects(pending,/改用其他模型/);
  await advanceMicrotasks();rpc.listener?.({method:'model/rerouted',params:{threadId:'thread-1',toModel:'different-model'}});
  await rejected;assert.equal(rpc.closeCount,1);
});
