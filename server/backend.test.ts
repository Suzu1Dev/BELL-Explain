import { withExample } from "./test-helpers.js";
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exampleLessons } from '../shared/examples.js';
import type { GenerateEvent, Lesson } from '../shared/types.js';
import { createApp, type AppOptions } from './app.js';
import { createChat, generateLesson, curationContext } from './ai.js';
import { LessonStore } from './store.js';
import { makeLesson, teachingSchema, liveTeachingSchema, requestSchema } from './schema.js';
import { extractSource, isPublicAddress, validatePublicUrl } from './sources.js';

const fixture = exampleLessons[0];
const config = {apiKey:'', model:'', baseUrl:'https://api.openai.com/v1'};
const request = {kind:'code' as const, content:'const answer = 42;', depth:'beginner' as const};
const teaching = () => teachingSchema.parse(withExample({...structuredClone(fixture),visual:{...structuredClone(fixture.visual),kind:'flow',scene:{layout:'flow',edges:[],groups:[]}}}));
const analysis = {title:'閉包', scope:'貼上內容', keyConcepts:['閉包'], explanationPlan:['理解環境','理解狀態'], caveats:[]};
const curation = {category:'JavaScript', tags:['閉包'], connections:[{targetId:fixture.id,sectionId:fixture.sections[0].id, reason:'共享詞法環境概念'},{targetId:'missing',sectionId:'missing',reason:'無效引用應移除'}]};
function listen(server: Server): Promise<number> { return new Promise(resolve => server.listen(0,'127.0.0.1', () => resolve((server.address() as AddressInfo).port))); }
async function setup(t: TestContext, overrides: Partial<AppOptions> = {}) {
  const store = overrides.store || new LessonStore(':memory:', exampleLessons);
  const server = createServer(createApp({store,examples:exampleLessons,config,...overrides}));
  const port = await listen(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {...init, headers:{host:'127.0.0.1:3001', 'content-type':'application/json', ...init.headers}});
  return {api,store};
}
function events(text:string): GenerateEvent[] { return text.trim().split('\n').map(line => JSON.parse(line) as GenerateEvent); }

test('SQLite persists favorites and deletions, seeds once, and removes dangling references on read', () => {
  const directory = mkdtempSync(join(tmpdir(),'bell-test-')); const path = join(directory,'notes.sqlite');
  try {
    let store = new LessonStore(path,exampleLessons);
    assert.equal(store.list().length,3);
    store.favorite(fixture.id,true); store.delete('demo-debounce'); store.close();
    store = new LessonStore(path,exampleLessons);
    assert.equal(store.list().length,2);
    assert.equal(store.get(fixture.id)?.favorite,true);
    assert.equal(store.get('demo-debounce'),undefined);
    assert.ok(store.list().every(lesson => lesson.connections.every(connection => connection.targetId !== 'demo-debounce')));
    store.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('input and generated visual references are validated; generated sections and connections are normalized', () => {
  assert.equal(requestSchema.safeParse({...request,content:''}).success,false);
  assert.equal(requestSchema.safeParse({...request,exampleId:'invented'}).success,false);
  let broken = teaching(); broken.visual.steps[0].activeNodeIds = ['does-not-exist'];
  assert.equal(teachingSchema.safeParse(broken).success,false);
  broken = teaching(); broken.sections[0].visualStep = 100;
  assert.equal(teachingSchema.safeParse(broken).success,false);
  broken = teaching(); broken.visual.nodes[1].id = broken.visual.nodes[0].id;
  assert.equal(teachingSchema.safeParse(broken).success,false);
  broken = teaching(); broken.visual.steps[0].activeNodeIds = [broken.visual.nodes[0].id,broken.visual.nodes[0].id];
  assert.equal(teachingSchema.safeParse(broken).success,false);
  for (const count of [7,8]) {
    broken = teaching();
    while (broken.visual.nodes.length < count) broken.visual.nodes.push({id:`extra-${broken.visual.nodes.length}`,label:'額外節點',detail:'測試超出可繪製範圍'});
    assert.equal(teachingSchema.safeParse(broken).success,false,`${count} nodes must be rejected`);
  }
  for (const kind of ['closure','event-loop','debounce']) {
    assert.equal(liveTeachingSchema.safeParse({...teaching(),visual:{...teaching().visual,kind}}).success,false,'Live model output must use flow');
  }
  assert.ok(exampleLessons.every(lesson => lesson.visual.kind !== 'flow'),'Curated specialized diagrams remain available');
  const result = makeLesson(teaching(),curation,fixture.source,exampleLessons,'generated');
  assert.equal(result.sections[0].id,'section-1'); assert.equal(result.connections.length,1);
  assert.equal(result.isDemo,false);
});

test('lessons retain creation order when favorites change, including equal creation timestamps', () => {
  const store = new LessonStore(':memory:',exampleLessons);
  try {
    const newer = {...structuredClone(fixture),id:'newer',createdAt:'2099-01-01T00:00:00.000Z',updatedAt:'2099-01-01T00:00:00.000Z'};
    store.save(newer);
    const before = store.list().map(lesson => lesson.id);
    assert.equal(before[0],'newer');
    store.favorite(fixture.id,true); store.favorite('demo-debounce',true);
    assert.deepEqual(store.list().map(lesson => lesson.id),before);
  } finally {store.close();}
});

test('local API rejects cross-origin writes, exposes no credential, and does not fabricate AI without configuration', async t => {
  const {api,store} = await setup(t);
  const response = await api('/api/generate',{method:'POST',body:JSON.stringify(request)});
  assert.equal(response.status,503); assert.match((await response.json()).error,/AI_API_KEY/);
  assert.equal(store.list().length,3);
  const crossOrigin = await api('/api/lessons/demo-closure',{method:'DELETE',headers:{origin:'https://untrusted.example'}});
  assert.equal(crossOrigin.status,403);
  const configResponse = await api('/api/config'); const visible = await configResponse.json();
  assert.equal(visible.configured,false); assert.equal('apiKey' in visible,false);
  for (const origin of ['http://127.0.0.1:3001','http://localhost:3001','http://127.0.0.1:5173','http://localhost:5173']) {
    assert.equal((await api('/api/config',{headers:{origin}})).status,200,origin);
  }
});

test('curation metadata and provider prompt budgets stay bounded as the library grows', async () => {
  const large = teaching();
  large.sections = Array.from({length:8},(_,index) => ({...large.sections[0],id:`section-${index}`,heading:'主題'.repeat(120),body:'內容'.repeat(4000),code:'example'.repeat(1000),concepts:Array.from({length:8},()=> '概念'.repeat(120))}));
  const library = Array.from({length:100},(_,index) => ({...structuredClone(fixture),id:`note-${index}`,sections:large.sections,tags:Array.from({length:8},()=> '標籤'.repeat(120))}));
  const context = curationContext(large,library);
  assert.ok(context.existing.length > 0); assert.ok(context.existing.length <= 40);
  assert.ok(JSON.stringify(context.existing).length <= 14_000);
  assert.ok(JSON.stringify(context).length < 30_000);
  assert.equal('code' in context.teaching.sections[0],false);
  const chat = createChat({apiKey:'test',model:'test',baseUrl:'http://127.0.0.1:1/v1'});
  await assert.rejects(() => chat('test','test',{content:'x'.repeat(80_000)},new AbortController().signal),/大小限制/);
});

test('curated generation is labeled, saved before complete, and editable with API CRUD', async t => {
  const {api,store} = await setup(t);
  store.delete(fixture.id);
  const response = await api('/api/generate',{method:'POST',body:JSON.stringify({...request,exampleId:fixture.id})});
  const emitted = events(await response.text());
  assert.deepEqual(emitted.filter(event => event.type === 'stage').map(event => event.stage),['read','analyze','teach','organize']);
  const complete = emitted.at(-1); assert.equal(complete?.type,'complete');
  if (complete?.type !== 'complete') throw new Error('Missing completion');
  assert.equal(complete.lesson.isDemo,true); assert.equal(complete.lesson.title,fixture.title);
  assert.deepEqual(store.get(fixture.id),complete.lesson);
  const saved = await api(`/api/lessons/${fixture.id}`,{method:'PATCH',body:JSON.stringify({favorite:true})});
  assert.equal((await saved.json()).favorite,true);
  assert.equal((await api(`/api/lessons/${fixture.id}`,{method:'DELETE'})).status,204);
  assert.equal((await api(`/api/lessons/${fixture.id}`)).status,404);
});

test('three independent AI roles produce validated durable lesson and filter invalid links', async t => {
  const roles:string[] = [];
  const {api,store} = await setup(t,{config:{...config,apiKey:'test-key',model:'test-model'},chat:async role => {roles.push(role); return roles.length === 1 ? analysis : roles.length === 2 ? teaching() : curation;}});
  const response = await api('/api/generate',{method:'POST',body:JSON.stringify(request)});
  const emitted = events(await response.text()); const complete = emitted.at(-1);
  assert.equal(roles.length,3); assert.equal(new Set(roles).size,3); assert.equal(complete?.type,'complete');
  if (complete?.type !== 'complete') throw new Error('Missing completion');
  assert.equal(complete.lesson.isDemo,false); assert.equal(complete.lesson.connections.length,1);
  assert.deepEqual(store.get(complete.lesson.id),complete.lesson);
});

test('invalid provider output returns sanitized streamed error and saves no partial note', async t => {
  const {api,store} = await setup(t,{config:{...config,apiKey:'secret-should-not-appear',model:'test'},chat:async () => ({secret:'secret-should-not-appear'})});
  const response = await api('/api/generate',{method:'POST',body:JSON.stringify(request)});
  const text = await response.text(); assert.doesNotMatch(text,/secret-should-not-appear/);
  assert.equal(events(text).at(-1)?.type,'error'); assert.equal(store.list().length,3);
});

test('a client disconnect leaves provider work running until it is cancelled, and saves no partial note', async t => {
  let start!: () => void; const started = new Promise<void>(resolve => {start=resolve;});
  let finish!: () => void; const aborted = new Promise<void>(resolve => {finish=resolve;});
  let signal!: AbortSignal;
  const {api,store} = await setup(t,{config:{...config,apiKey:'test',model:'test'},chat:async (_role,_instruction,_data,callSignal) => {
    signal=callSignal; start(); return new Promise((_resolve,reject) => callSignal.addEventListener('abort',() => { finish(); reject(new DOMException('Aborted','AbortError')); },{once:true}));
  }});
  const response = await api('/api/generate',{method:'POST',body:JSON.stringify(request)});
  const id = JSON.parse((await response.body!.getReader().read().then(chunk => new TextDecoder().decode(chunk.value))).split('\n')[0]).id as string;
  await started; await response.body?.cancel().catch(() => {});
  await new Promise(resolve => setTimeout(resolve,50));
  assert.equal(signal.aborted,false);
  assert.equal((await api(`/api/jobs/${id}`,{method:'DELETE'})).status,204);
  await Promise.race([aborted,new Promise((_,reject) => setTimeout(() => reject(new Error('Cancel was not propagated')),1500).unref())]);
  assert.equal(store.list().length,3);
});

test('public source guard rejects private and reserved addresses and non-HTTPS URLs', () => {
  for (const address of ['127.0.0.1','10.0.0.2','169.254.169.254','192.168.1.1','::1','fc00::1','::ffff:127.0.0.1','224.0.0.1','0.0.0.0']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('1.1.1.1'),true);
  for (const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://user:pass@example.com','https://example.com:8443','file:///tmp/test','https://localhost']) assert.throws(() => validatePublicUrl(url));
  // Notes sync with addresses up to 4,000 characters, so a longer one is refused before it is read.
  assert.throws(() => validatePublicUrl(`https://example.com/${'a'.repeat(4000)}`), /4,000/);
  assert.equal(validatePublicUrl(`https://example.com/${'a'.repeat(3900)}`).href.length, 3920);
});

test('article extraction excludes scripts and describes actual static scope; pasted source limits are disclosed', async () => {
  const source = await extractSource({...request,kind:'url',content:'https://example.com'},new AbortController().signal,async () => ({url:'https://example.com/article',contentType:'text/html',text:'<html><head><title>文章標題</title></head><body><nav>MENU</nav><article><h1>文章</h1><p>'+ '這是可以閱讀的文章內容。'.repeat(12) + '</p><script>DO_NOT_INCLUDE</script></article></body></html>'}));
  assert.equal(source.label,'文章標題'); assert.doesNotMatch(source.content,/DO_NOT_INCLUDE|MENU/); assert.match(source.scope!,/靜態文字/);
  const pasted = await extractSource({...request,content:'x'.repeat(50_000)},new AbortController().signal);
  assert.equal(pasted.truncated,true); assert.equal(pasted.content.length,45_000);
});

test('repository extraction reads only its documented README and selected small files', async () => {
  const reads:string[] = [];
  const root = 'https://api.github.com/repos/example/project';
  const encoded = (content:string) => ({encoding:'base64', content:Buffer.from(content).toString('base64'),size:content.length});
  const payloads:Record<string,unknown> = {
    [root]:{default_branch:'main',description:'A public example'},
    [`${root}/readme?ref=main`]:encoded('# Example\nA learning project.'),
    [`${root}/contents?ref=main`]:[{name:'src',path:'src',type:'dir',size:0},{name:'huge.ts',path:'huge.ts',type:'file',size:90_000}],
    [`${root}/contents/src?ref=main`]:[{name:'index.ts',path:'src/index.ts',type:'file',size:40},{name:'index.test.ts',path:'src/index.test.ts',type:'file',size:40}],
    [`${root}/contents/src/index.ts?ref=main`]:encoded('export const example = () => 42;'),
  };
  const source = await extractSource({...request,kind:'repo',content:'https://github.com/example/project'},new AbortController().signal,async url => {
    reads.push(url); assert.ok(url in payloads,`Unexpected read: ${url}`);
    return {url, contentType:'application/json',text:JSON.stringify(payloads[url])};
  });
  assert.match(source.scope!,/README、src\/index.ts/); assert.match(source.scope!,/未讀取完整 repository/);
  assert.match(source.content,/export const example/); assert.equal(reads.length,5);
  await assert.rejects(() => extractSource({...request,kind:'repo',content:'https://github.com/example/project/tree/main'},new AbortController().signal),/根網址/);
});

test('Chat Completions adapter uses isolated system/user messages and validates all three responses', async t => {
  const received: Array<{messages:Array<{role:string;content:string}>;response_format:{type:string};model:string}> = [];
  const mock = createServer(async (req,res) => {
    const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(received.length === 1 ? analysis : received.length === 2 ? teaching() : curation)}}]}));
  });
  const port = await listen(mock); t.after(async () => {mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));});
  const chat = createChat({apiKey:'local-test-only',baseUrl:`http://127.0.0.1:${port}/v1`,model:'test-model'});
  const lesson = await generateLesson(request,fixture.source,exampleLessons,chat,new AbortController().signal,() => {});
  assert.equal(received.length,3); assert.equal(lesson.isDemo,false);
  for (const payload of received) { assert.equal(payload.response_format.type,'json_object'); assert.deepEqual(payload.messages.map(message => message.role),['system','user']); assert.equal(payload.model,'test-model'); }
  assert.match(received[0].messages[0].content,/不可信資料/);
});

test('built frontend: a missing /assets chunk is a plain 404 and other routes still get the SPA page', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bell-dist-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'assets'), { recursive: true });
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Explain static fixture</title>');
  writeFileSync(join(directory, 'assets', 'index-abc.js'), 'export const fixture = true;');
  const { api } = await setup(t, { distPath: directory });

  const current = await api('/assets/index-abc.js');
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await current.text(), 'export const fixture = true;');

  const missing = await api('/assets/LessonPage-old.js');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') || '', /text\/plain/);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await missing.text(), /Explain static fixture/);

  for (const path of ['/review', '/assetsx/foo']) {
    const page = await api(path);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get('cache-control'), 'no-cache', path);
    assert.match(await page.text(), /Explain static fixture/, path);
  }
  const missingApi = await api('/api/missing');
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: '找不到此 API。' });
});

test('PDF viewer assets are served read-only and unknown or escaping paths answer 404', async t => {
  const { api } = await setup(t);
  const cmap = await api('/api/pdfjs/cmaps/UniCNS-UTF16-H.bcmap');
  assert.equal(cmap.status, 200);
  assert.ok((await cmap.arrayBuffer()).byteLength > 1000);
  assert.equal((await api('/api/pdfjs/standard_fonts/FoxitSerif.pfb')).status, 200);
  for (const path of ['/api/pdfjs/standard_fonts/missing.pfb', '/api/pdfjs/cmaps/..%2f..%2fpackage.json', '/api/pdfjs/cmaps/']) {
    const response = await api(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /產生過程/);
  }
});
test('page images reach only the analysis and teaching agents, labelled, and a rejecting provider gets a clear hint', async t => {
  const received: Array<{messages:Array<{role:string;content:unknown}>}> = [];
  let reject = false;
  const mock = createServer(async (req,res) => {
    const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (reject) { res.statusCode = 400; res.end('{}'); return; }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(received.length === 1 ? analysis : received.length === 2 ? teaching() : curation)}}]}));
  });
  const port = await listen(mock); t.after(async () => {mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));});
  const chat = createChat({apiKey:'local-test-only',baseUrl:`http://127.0.0.1:${port}/v1`,model:'test-model'});
  const images = [{mimeType:'image/png',data:'iVBORw0KGgo=',label:'第 4 頁影像'}];
  await generateLesson(request,fixture.source,exampleLessons,chat,new AbortController().signal,() => {},images);
  for (const payload of received.slice(0,2)) {
    const content = payload.messages[1].content as Array<{type:string;text?:string;image_url?:{url:string}}>;
    assert.equal(JSON.parse(content[0].text!).pageImages[0],'第 4 頁影像');
    assert.deepEqual(content.slice(1),[{type:'text',text:'第 4 頁影像'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}]);
    assert.match(String(payload.messages[0].content),/頁面影像/);
  }
  assert.equal(typeof received[2].messages[1].content,'string');
  reject = true;
  await assert.rejects(chat('分析代理','Return JSON',{},new AbortController().signal,undefined,images),/不支援影像/);
});
