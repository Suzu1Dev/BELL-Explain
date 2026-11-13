import { withExample } from "./test-helpers.js";
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { GenerateEvent, Lesson } from '../shared/types.js';
import { DOCUMENT_MAX_BYTES } from '../shared/documents.js';
import { exampleLessons } from '../shared/examples.js';
import { createApp, type AppOptions } from './app.js';
import type { ChatCall } from './ai.js';
import { LessonStore } from './store.js';
import { KnowledgeService } from './knowledge.js';
import { SyncService } from './sync.js';
import { lessonHash } from './sync-protocol.js';
import { CloudSyncStore, createCloudApp } from '../cloud/app.js';
import { ProviderService } from './provider-router.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { requestSchema, teachingSchema } from './schema.js';
import { DocumentService } from './documents.js';
import type { DocumentPreview } from '../shared/documents.js';
import type { Source } from '../shared/types.js';
import { lessonMarkdown } from '../shared/lesson-markdown.js';
import { syncLessonSchema } from './sync-protocol.js';

const token='integration-only-synthetic-local-cloud-token-12345';
const template=exampleLessons[0];
const config={apiKey:'synthetic-test-key',model:'fixture',baseUrl:'https://never-called.invalid/v1'};
const teaching=()=>teachingSchema.parse(withExample({...structuredClone(template),visual:{...structuredClone(template.visual),kind:'flow',scene:{layout:'memory',edges:[],groups:[]}}}));
const recordingChat=(calls:Array<{role:string;data:Record<string,unknown>}>=[]):ChatCall=>async(role,_instruction,data)=> {
  calls.push({role,data:structuredClone(data) as Record<string,unknown>});
  if(role==='分析代理')return {title:'Integration analysis',scope:'Submitted source only',keyConcepts:['state'],explanationPlan:['Read source','Explain state'],caveats:[]};
  if(role==='教學代理')return teaching();
  return {category:'Integration',tags:['state'],connections:[]};
};
function post(body:unknown):RequestInit{return {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};}
async function listen(server:Server){return new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));}
async function closeServer(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
function events(body:string):GenerateEvent[]{return body.trim().split('\n').map(line=>JSON.parse(line));}

async function setup(t:TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'bell-integration-'));
  const cloud=new CloudSyncStore(join(directory,'cloud.sqlite'));
  const cloudServer=createServer(createCloudApp({store:cloud,token}));const remoteUrl=await listen(cloudServer);
  const devices:Array<{store:LessonStore;knowledge:KnowledgeService;sync:SyncService;server:Server}>=[];
  t.after(async()=>{for(const device of devices){await closeServer(device.server);await device.sync.close();await device.knowledge.close();device.store.close();}await closeServer(cloudServer);cloud.close();rmSync(directory,{recursive:true,force:true});});
  async function device(name:string,seeds:Lesson[]=[],overrides:Partial<AppOptions>={}) {
    const store=new LessonStore(join(directory,`${name}-notes.sqlite`),seeds);
    const knowledge=new KnowledgeService({dbPath:join(directory,`${name}-knowledge.sqlite`),cacheDir:join(directory,`${name}-cache`)});knowledge.reconcileLessons(store.listRaw());
    // Match server/index.ts's raw-document and remote-index adapters exactly.
    const sync=new SyncService({path:join(directory,`${name}-sync.sqlite`),intervalMs:60_000,lessons:{list:()=>store.listRaw(),get:id=>store.getRaw(id),save:lesson=>store.save(lesson),delete:id=>store.delete(id)},onRemoteChange:(lesson,id)=>{if(lesson)knowledge.upsertLesson(lesson);else knowledge.deleteLesson(id);}});
    const server=createServer(createApp({store,knowledge,sync,examples:exampleLessons,config,chat:recordingChat(),...overrides}));
    const url=await listen(server);devices.push({store,knowledge,sync,server});
    return {store,knowledge,sync,api:(path:string,init?:RequestInit)=>fetch(`${url}/api${path}`,init),connect:()=>sync.configure({remoteUrl,token,uploadExisting:true})};
  }
  return {directory,cloud,device};
}

test('indexed repository request may omit content but cannot override a non-repository source',()=> {
  assert.equal(requestSchema.safeParse({kind:'repo',content:'',indexedRepoId:'committed-repo',question:'Where is state stored?',depth:'beginner'}).success,true,'a selected indexed repo is sufficient input');
  for(const kind of ['code','article','concept','url'])assert.equal(requestSchema.safeParse({kind,content:'const x=1;',indexedRepoId:'committed-repo',depth:'beginner'}).success,false,`indexedRepoId must not silently replace ${kind} input`);
});

test('selected repository citations and explicit learning question reach both teaching roles, then lesson becomes searchable',async t=> {
  const env=await setup(t);const calls:Array<{role:string;data:Record<string,unknown>}>=[];
  const app=await env.device('writer',[],{chat:recordingChat(calls),extract:async()=>{throw new Error('indexed repository must bypass legacy extraction');}});
  const repoPath=join(env.directory,'repository');mkdirSync(repoPath);writeFileSync(join(repoPath,'cache.ts'),'export const cachedAnswer = 42;\n');
  execFileSync('git',['init','--template=',repoPath],{stdio:'ignore'});execFileSync('git',['-C',repoPath,'add','cache.ts']);execFileSync('git',['-C',repoPath,'-c','user.name=Integration','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','fixture'],{stdio:'ignore'});
  const indexed=app.knowledge.createRepository({source:'local',path:repoPath});await app.knowledge.waitForIdle();
  const question='只解釋 cachedAnswer 的生命週期與儲存位置';
  const response=await app.api('/generate',post({kind:'repo',content:'',indexedRepoId:indexed.repository.id,question,depth:'advanced'}));assert.equal(response.status,200);
  const output=events(await response.text());const complete=output.find(event=>event.type==='complete');assert.ok(complete && complete.type==='complete',JSON.stringify(output));
  assert.equal(complete.lesson.source.kind,'repo');assert.match(complete.lesson.source.content,/cache\.ts:L1-L2/);assert.match(complete.lesson.source.content,/export const cachedAnswer = 42/);
  assert.equal(app.store.getRaw(complete.lesson.id)?.id,complete.lesson.id);
  assert.ok((await app.knowledge.search('函式')).results.some(result=>result.ownerId===complete.lesson.id),'completed generation must be indexed before consumers search');
  for(const role of ['分析代理','教學代理'])assert.equal(calls.find(call=>call.role===role)?.data.learningQuestion,question,`${role} must receive the actual question as dedicated learningQuestion data`);
  const removal=await app.api(`/knowledge/repositories/${indexed.repository.id}`,{method:'DELETE'});assert.equal(removal.status,204);
  assert.equal(app.knowledge.repositories().length,0);assert.equal((await app.knowledge.search('cachedAnswer',{repositoryId:indexed.repository.id})).results.length,0);
  assert.equal(app.store.getRaw(complete.lesson.id)?.source.content,complete.lesson.source.content,'removing an index preserves saved lesson source snapshots');
  assert.ok((await app.knowledge.search('函式')).results.some(result=>result.ownerId===complete.lesson.id),'index removal preserves knowledge entries belonging to saved notes');
});

test('favorites preserve raw links and sync hashes; local and remote deletions remove semantic-search entries',async t=> {
  const env=await setup(t);const unresolved={...structuredClone(template),id:'linked-note',connections:[{targetId:'not-yet-on-this-device',sectionId:'section-a',reason:'原始連結暫時沒有本機目標'}]};
  const a=await env.device('a',[unresolved]);const b=await env.device('b');
  await a.connect();await b.connect();
  assert.equal(b.store.list()[0].connections.length,0,'display filters missing targets');
  assert.equal(b.store.listRaw()[0].connections.length,1,'sync retains original unresolved links');
  assert.equal(lessonHash(a.store.getRaw(unresolved.id)!),lessonHash(b.store.getRaw(unresolved.id)!));
  await a.sync.sync();await b.sync.sync();assert.equal(env.cloud.pull(0).changes.length,1,'view filtering must not generate phantom cloud revisions');
  const before=a.knowledge.status().embedding.totalChunks;
  const favorite=await a.api(`/lessons/${unresolved.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({favorite:true})});assert.equal(favorite.status,200);
  await a.sync.sync();await b.sync.sync();
  assert.equal(a.store.getRaw(unresolved.id)?.connections.length,1);assert.equal(b.store.getRaw(unresolved.id)?.connections.length,1);assert.equal(b.store.getRaw(unresolved.id)?.favorite,true);
  assert.equal(a.knowledge.status().embedding.totalChunks,before,'favorite must not duplicate indexed paragraphs');assert.equal(a.sync.status().conflicts,0);assert.equal(b.sync.status().conflicts,0);
  assert.ok((await b.knowledge.search('閉包')).results.length>0,'pulled notes must enter the local knowledge index');
  const removal=await a.api(`/lessons/${unresolved.id}`,{method:'DELETE'});assert.equal(removal.status,204);
  assert.equal((await a.knowledge.search('閉包')).results.length,0);await a.sync.sync();await b.sync.sync();
  assert.equal(b.store.getRaw(unresolved.id),undefined);assert.equal((await b.knowledge.search('閉包')).results.length,0);assert.equal(env.cloud.pull(0).changes.at(-1)?.document.lesson,null);
});

test('opening an existing curated lesson preserves its raw unresolved connections and sync content hash',async t=> {
  const env=await setup(t);const note={...structuredClone(template),connections:[{targetId:'temporarily-unavailable-target',sectionId:'section-a',reason:'裝置尚未取得目標筆記'}]};
  const app=await env.device('curated',[note]);const before=lessonHash(app.store.getRaw(note.id)!);
  const response=await app.api('/generate',post({kind:'code',content:'',depth:'beginner',exampleId:note.id}));assert.equal(response.status,200);assert.ok(events(await response.text()).some(event=>event.type==='complete'));
  assert.equal(app.store.getRaw(note.id)?.connections.length,1,'opening a saved demo must not destructively apply display filtering');
  assert.equal(lessonHash(app.store.getRaw(note.id)!),before);
});

test('configured provider is used for generation even when legacy environment API config is empty',async t=> {
  const env=await setup(t);const settings=new ProviderSettingsStore(':memory:',{provider:'api'});t.after(()=>settings.close());
  const calls:Array<{role:string;data:Record<string,unknown>}>=[];let created=0;
  class FakeProvider extends ProviderService {override async createChat():Promise<ChatCall>{created++;return recordingChat(calls);}}
  const provider=new FakeProvider({store:settings,apiConfig:config,discover:async()=>({id:'codex',name:'Codex',available:false,authenticated:false,message:'Fixture has no Codex login',models:[]}),discoverClaude:async()=>({id:'claude',name:'Claude Code',available:false,authenticated:false,message:'offline',models:[]}),discoverAntigravity:async()=>({id:'antigravity',name:'Antigravity',available:false,authenticated:false,message:'offline',models:[]})});
  const app=await env.device('provider',[],{provider,chat:undefined,config:{apiKey:'',model:'',baseUrl:'https://never-called.invalid/v1'}});
  const status=await (await app.api('/config')).json();assert.equal(status.configured,true);assert.equal(status.provider,'api');
  const response=await app.api('/generate',post({kind:'code',content:'const value = 42;',depth:'beginner'}));const output=events(await response.text());
  assert.equal(response.status,200);assert.ok(output.some(event=>event.type==='complete'),JSON.stringify(output));assert.equal(created,1);assert.equal(calls.length,3);
});

test('uploaded document travels through generation, persistence, source search, export and two-device sync', async t => {
  const env=await setup(t);
  const documents=new DocumentService({directory:join(env.directory,'documents')});
  t.after(()=>documents.close());
  const calls:Array<{role:string;data:Record<string,unknown>}>=[];
  const a=await env.device('document-writer',[],{documents,chat:recordingChat(calls),extract:async()=>{throw new Error('document must use persisted extraction');}});
  const b=await env.device('document-reader');
  const file='Order spec\n\nIdempotency-ZebraToken prevents duplicate orders.\n\nA repeated request returns the original result.';
  const response=await a.api('/documents',{method:'POST',headers:{'content-type':'application/octet-stream','x-document-name':encodeURIComponent('訂單技術規格.md')},body:file});
  assert.ok(response.ok,await response.clone().text());
  const uploaded=await response.json() as DocumentPreview;
  assert.equal(uploaded.name,'訂單技術規格.md');assert.match(uploaded.preview,/Idempotency-ZebraToken/);
  const question='為什麼重送不會建立兩筆訂單？';
  const generated=await a.api('/generate',post({kind:'document',content:'',documentId:uploaded.id,question,depth:'beginner'}));
  const output=events(await generated.text());
  const complete=output.find(event=>event.type==='complete');assert.ok(complete && complete.type==='complete',JSON.stringify(output));
  const lesson=a.store.getRaw(complete.lesson.id)!;
  assert.equal(lesson.source.kind,'document');assert.equal(lesson.source.document?.sha256,uploaded.sha256);
  assert.match(lesson.source.content,/第 2 段/);assert.match(lesson.source.content,/Idempotency-ZebraToken/);
  for(const call of calls.filter(call=>call.role!=='知識整理代理')) {
    assert.equal(call.data.learningQuestion,question);
    assert.deepEqual((call.data.source as Source).document,lesson.source.document);
  }
  assert.ok((await a.knowledge.search('Idempotency-ZebraToken')).results.some(result=>result.ownerId===lesson.id));
  assert.ok((await a.knowledge.search('訂單技術規格')).results.some(result=>result.ownerId===lesson.id));
  const md=lessonMarkdown(lesson);assert.match(md,/訂單技術規格\.md/);assert.match(md,/Idempotency-ZebraToken/);assert.match(md,/SHA-256/);
  assert.ok(syncLessonSchema.safeParse(lesson).success);
  for(const change of [{selectedUnits:[9999]},{size:DOCUMENT_MAX_BYTES+1},{sha256:'invalid'}])assert.equal(syncLessonSchema.safeParse({...lesson,source:{...lesson.source,document:{...lesson.source.document,...change}}}).success,false);
  await a.connect();await b.connect();
  assert.equal(lessonHash(b.store.getRaw(lesson.id)!),lessonHash(lesson));
  assert.ok((await b.knowledge.search('Idempotency-ZebraToken')).results.some(result=>result.ownerId===lesson.id));
  const protectedFile=await a.api(`/documents/${uploaded.id}`,{method:'DELETE'});assert.equal(protectedFile.status,409);
  const original=await a.api(`/documents/${uploaded.id}/file`);assert.equal(await original.text(),file);assert.match(original.headers.get('content-disposition') || '',/attachment/);
});

test('document generation requires a stored-file ID and cannot silently substitute pasted content or examples',()=> {
  const input={kind:'document',content:'',documentId:'121d7e51-3c59-4ed1-83b2-08f590ab4d81',depth:'beginner'};
  assert.equal(requestSchema.safeParse(input).success,true);
  for(const change of [{documentId:undefined},{documentId:'../../file'},{content:'fake text'},{kind:'concept'},{exampleId:'demo-closure'},{indexedRepoId:'repository'}])
    assert.equal(requestSchema.safeParse({...input,...change}).success,false,JSON.stringify(change));
});
