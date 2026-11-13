import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Lesson } from '../shared/types.js';
import { exampleLessons } from '../shared/examples.js';
import { CloudSyncStore, createCloudApp } from '../cloud/app.js';
import { SyncService, normalizeSyncUrl, testSyncConnection } from './sync.js';
import { lessonHash } from './sync-protocol.js';
import { LessonStore } from './store.js';

const token = 'integration-test-secret-with-at-least-thirty-two-characters';
const note = (id = 'note-one'):Lesson => ({...structuredClone(exampleLessons[0]),id,connections:[]});
class Notes {
  data = new Map<string,Lesson>();
  list() {return [...this.data.values()].map(value => structuredClone(value));}
  get(id:string) {const value = this.data.get(id);return value ? structuredClone(value) : undefined;}
  save(value:Lesson) {this.data.set(value.id,structuredClone(value));}
  delete(id:string) {return this.data.delete(id);}
}
async function listen(server:Server) {return new Promise<string>(resolve => server.listen(0,'127.0.0.1',() => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));}
async function setup(t:TestContext) {
  const directory = mkdtempSync(join(tmpdir(),'bell-sync-'));
  const cloud = new CloudSyncStore(join(directory,'cloud.sqlite'));
  const app = createCloudApp({store:cloud,token});let online = true;
  const server = createServer((req,res) => {if (!online) {res.statusCode=503;res.end();} else app(req,res);});
  const remoteUrl = await listen(server);
  const clients:SyncService[] = [];
  const client = (name:string,notes = new Notes()) => {
    const sync = new SyncService({path:join(directory,`${name}.sqlite`),lessons:notes,intervalMs:60_000});clients.push(sync);return {sync,notes};
  };
  t.after(async () => {
    for (const sync of clients) await sync.close().catch(() => {});
    server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));cloud.close();rmSync(directory,{recursive:true,force:true});
  });
  const connect = (sync:SyncService) => sync.configure({remoteUrl,token,uploadExisting:true});
  const api = (path:string,body?:unknown,credential = token) => fetch(`${remoteUrl}${path}`,{method:body ? 'POST' : 'GET',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
  return {directory,cloud,remoteUrl,client,connect,api,setOnline:(value:boolean) => {online=value;}};
}

test('sync two devices creates, updates, favorites and deletes with durable tombstones', async t => {
  const env = await setup(t);const a = env.client('a');const b = env.client('b');
  a.notes.save(note());await env.connect(a.sync);await env.connect(b.sync);
  assert.deepEqual(b.notes.get('note-one'),a.notes.get('note-one'));
  const changed = {...a.notes.get('note-one')!,favorite:true,title:'已更新的教學'};a.notes.save(changed);a.sync.updatedLesson(changed);
  await a.sync.sync();await b.sync.sync();assert.equal(b.notes.get('note-one')?.title,'已更新的教學');assert.equal(b.notes.get('note-one')?.favorite,true);
  b.notes.delete('note-one');b.sync.deletedLesson('note-one');await b.sync.sync();await a.sync.sync();assert.equal(a.notes.get('note-one'),undefined);
  const changes = env.cloud.pull(0).changes;assert.equal(changes.length,3);assert.equal(changes.at(-1)?.document.lesson,null);
  assert.equal(a.sync.status().pending,0);assert.equal(b.sync.status().conflicts,0);
});

test('a note from a scan-only PDF, with no extracted text, syncs', async t => {
  const env = await setup(t);const a = env.client('a');const b = env.client('b');
  const document = {id:randomUUID(),name:'掃描講義.pdf',format:'pdf' as const,mimeType:'application/pdf',size:2048,sha256:'a'.repeat(64),unitLabel:'page' as const,
    totalUnits:3,parsedUnits:3,extractedChars:0,warnings:[],createdAt:new Date().toISOString(),selectedUnits:[1,2,3]};
  a.notes.save({...note('scan'),source:{...note().source,kind:'document',document}});
  await env.connect(a.sync);await env.connect(b.sync);
  assert.equal(a.sync.status().pending,0);assert.equal(b.notes.get('scan')?.source.document?.extractedChars,0);
});

test('offline divergent edits preserve both versions and explicit resolution converges', async t => {
  const env = await setup(t);const a = env.client('a');const b = env.client('b');a.notes.save(note());await env.connect(a.sync);await env.connect(b.sync);
  env.setOnline(false);
  const av = {...a.notes.get('note-one')!,title:'裝置 A 修改'};a.notes.save(av);a.sync.updatedLesson(av);
  const bv = {...b.notes.get('note-one')!,title:'裝置 B 修改'};b.notes.save(bv);b.sync.updatedLesson(bv);
  await Promise.all([a.sync.sync().catch(() => {}),b.sync.sync().catch(() => {})]);
  assert.equal(a.sync.status().pending,1);assert.equal(b.sync.status().pending,1);
  env.setOnline(true);await a.sync.sync();await b.sync.sync();
  const conflict = b.sync.conflicts()[0];assert.equal(conflict.local?.title,'裝置 B 修改');assert.equal(conflict.remote?.title,'裝置 A 修改');
  assert.equal(b.notes.get('note-one')?.title,'裝置 B 修改');assert.equal(b.sync.status().pending,0);
  await b.sync.resolveConflict('note-one','both');await a.sync.sync();
  assert.equal(a.notes.list().length,2);assert.equal(b.sync.status().conflicts,0);
  assert.equal(a.notes.get('note-one')?.title,'裝置 A 修改');assert.ok(a.notes.list().some(item => item.title.startsWith('裝置 B 修改')));
});

test('stale offline edit cannot resurrect a deletion; retaining both keeps the tombstone', async t => {
  const env = await setup(t);const a = env.client('a');const b = env.client('b');a.notes.save(note());await env.connect(a.sync);await env.connect(b.sync);
  env.setOnline(false);const updated = {...b.notes.get('note-one')!,title:'刪除前的離線修改'};b.notes.save(updated);b.sync.updatedLesson(updated);await b.sync.sync().catch(() => {});
  env.setOnline(true);a.notes.delete('note-one');a.sync.deletedLesson('note-one');await a.sync.sync();await b.sync.sync();
  assert.equal(b.sync.conflicts()[0].remote,null);assert.equal(b.sync.conflicts()[0].local?.title,'刪除前的離線修改');
  assert.equal(env.cloud.pull(0).changes.at(-1)?.document.lesson,null);
  await b.sync.resolveConflict('note-one','both');await a.sync.sync();
  assert.equal(a.notes.get('note-one'),undefined);assert.equal(b.notes.get('note-one'),undefined);assert.equal(a.notes.list().length,1);
  assert.notEqual(a.notes.list()[0].id,'note-one');
});

test('push is idempotent and rejects operation reuse, unauthenticated and malformed requests', async t => {
  const env = await setup(t);const op = {operationId:randomUUID(),id:'note-one',baseRevision:0,lesson:note()};
  const first = await env.api('/v1/push',op);assert.equal(first.status,200);const result = await first.json();
  const replay = await env.api('/v1/push',op);assert.deepEqual(await replay.json(),result);assert.equal(env.cloud.pull(0).changes.length,1);
  assert.equal((await env.api('/v1/push',{...op,lesson:{...op.lesson,title:'不同的操作'}})).status,409);
  assert.equal((await env.api('/v1/info',undefined,'incorrect')).status,401);
  assert.equal((await env.api('/v1/push',{...op,operationId:randomUUID(),lesson:{id:'note-one'}})).status,400);
  assert.equal((await env.api('/v1/pull?cursor=-1')).status,400);
  await assert.rejects(() => testSyncConnection({remoteUrl:env.remoteUrl,token:'x'.repeat(32)}),/憑證無效/);
  const stale = await (await env.api('/v1/push',{...op,operationId:randomUUID(),lesson:{...op.lesson,title:'過期修改'}})).json();
  assert.equal(stale.accepted,false);assert.equal(stale.document.revision,1);
});

test('offline queue and settings survive restart; reconnect resolves same content despite history', async t => {
  const env = await setup(t);const a = env.client('a');a.notes.save(note());await env.connect(a.sync);
  env.setOnline(false);const change = {...a.notes.get('note-one')!,title:'重啟之後要上傳'};a.notes.save(change);a.sync.updatedLesson(change);await a.sync.sync().catch(() => {});
  assert.equal(a.sync.status().pending,1);await a.sync.close();
  const restarted = env.client('a',a.notes);assert.equal(restarted.sync.status().configured,true);assert.equal(restarted.sync.status().pending,1);
  await restarted.sync.sync().catch(() => {});env.setOnline(true);await restarted.sync.sync();
  const b = env.client('b');b.notes.save({...change,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z'});await env.connect(b.sync);
  assert.equal(b.sync.status().conflicts,0);assert.equal(b.sync.status().pending,0);
  assert.equal(env.cloud.pull(0).changes.length,2);assert.equal(env.cloud.pull(0).changes.at(-1)?.document.lesson?.title,change.title);
});

test('connecting requires upload consent; testing and disconnect never expose the credential', async t => {
  const env = await setup(t);const a = env.client('a');a.notes.save(note());
  await testSyncConnection({remoteUrl:env.remoteUrl,token});assert.equal(env.cloud.pull(0).changes.length,0);
  await assert.rejects(() => a.sync.configure({remoteUrl:env.remoteUrl,token,uploadExisting:false as unknown as true}),/確認/);
  assert.equal(env.cloud.pull(0).changes.length,0);assert.equal(a.sync.status().configured,false);
  await env.connect(a.sync);assert.doesNotMatch(JSON.stringify(a.sync.status()),new RegExp(token));
  await a.sync.disconnect();assert.equal(a.sync.status().configured,false);assert.equal(a.notes.list().length,1);assert.equal(env.cloud.pull(0).changes.length,1);
  a.notes.save({...note(),title:'不再同步'});a.sync.updatedLesson(a.notes.get('note-one')!);await a.sync.sync();assert.equal(env.cloud.pull(0).changes.length,1);
  for (const invalid of ['http://example.com','file:///tmp/sync','https://user:pass@example.com','https://example.com?token=secret']) assert.throws(() => normalizeSyncUrl(invalid));
  assert.equal(normalizeSyncUrl('https://sync.example.com/'),'https://sync.example.com');assert.equal(lessonHash({...note(),updatedAt:'2099-01-01T00:00:00.000Z'}),lessonHash(note()));
});

test('local and remote conflict resolutions converge without overwriting the other version silently', async t => {
  const env = await setup(t);const a = env.client('a');const b = env.client('b');a.notes.save(note());await env.connect(a.sync);await env.connect(b.sync);
  for (const strategy of ['local','remote'] as const) {
    env.setOnline(false);
    const local = {...b.notes.get('note-one')!,title:`本機 ${strategy}`};b.notes.save(local);b.sync.updatedLesson(local);await b.sync.sync().catch(() => {});
    env.setOnline(true);const remote = {...a.notes.get('note-one')!,title:`遠端 ${strategy}`};a.notes.save(remote);a.sync.updatedLesson(remote);await a.sync.sync();await b.sync.sync();
    assert.equal(b.sync.status().conflicts,1);await b.sync.resolveConflict('note-one',strategy);await a.sync.sync();
    assert.equal(a.notes.get('note-one')?.title,strategy === 'local' ? local.title : remote.title);assert.equal(b.sync.status().conflicts,0);
  }
});

test('cloud data, workspace identity and idempotency remain durable after restart', () => {
  const directory = mkdtempSync(join(tmpdir(),'bell-cloud-'));
  try {
    const path = join(directory,'cloud.sqlite');let cloud = new CloudSyncStore(path);const workspaceId = cloud.workspaceId;
    const op = {operationId:randomUUID(),id:'note-one',baseRevision:0,lesson:note()};const result = cloud.push(op);cloud.close();
    cloud = new CloudSyncStore(path);assert.equal(cloud.workspaceId,workspaceId);assert.deepEqual(cloud.push(op),result);assert.equal(cloud.pull(0).changes.length,1);cloud.close();
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('sync recovers a note mutation committed before its queue hook across a local database restart', async t => {
  const env = await setup(t);let store = new LessonStore(join(env.directory,'lessons.sqlite'));
  store.save(note());let sync = new SyncService({path:join(env.directory,'metadata.sqlite'),lessons:store,intervalMs:60_000});await env.connect(sync);
  // Simulate a process exiting after the note commit but before updatedLesson().
  store.save({...note(),title:'需要恢復的本機提交'});await sync.close();store.close();
  store = new LessonStore(join(env.directory,'lessons.sqlite'));sync = new SyncService({path:join(env.directory,'metadata.sqlite'),lessons:store,intervalMs:60_000});
  try {await sync.sync();assert.equal(env.cloud.pull(0).changes.at(-1)?.document.lesson?.title,'需要恢復的本機提交');}
  finally {await sync.close();store.close();}
});

test('an unreadable local note stops sync instead of being pushed as a deletion', async t => {
  const {directory,client,connect,cloud} = await setup(t);
  // Device A uses a real LessonStore read the way production wires sync: strictly.
  const store = new LessonStore(join(directory,'a-notes.sqlite'),[]);
  t.after(() => store.close());
  store.save(note('note-one'));
  const a = client('a',{list:() => store.listRaw({strict:true}),get:(id:string) => store.getRaw(id,{strict:true}),save:(value:Lesson) => store.save(value),delete:(id:string) => store.delete(id)} as unknown as Notes);
  const b = client('b');
  await connect(a.sync);await connect(b.sync);
  await a.sync.sync();await b.sync.sync();
  assert.ok(b.notes.get('note-one'));
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(join(directory,'a-notes.sqlite'));
  raw.prepare("UPDATE lessons SET json='{broken' WHERE id='note-one'").run();raw.close();
  await assert.rejects(a.sync.sync());
  await b.sync.sync();
  // Nothing was pushed: the cloud and device B keep the note, and A's library still lists the readable rest.
  assert.ok(b.notes.get('note-one'));
  assert.ok(JSON.stringify(cloud.pull(0)).includes('note-one'));
  assert.equal(JSON.stringify(cloud.pull(0)).includes('"lesson":null'),false);
  assert.deepEqual(store.listRaw(),[]);
});
