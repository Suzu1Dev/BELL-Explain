import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeService, chunkText, type EmbeddingProvider } from './knowledge.js';
import { exampleLessons } from '../shared/examples.js';
import type { Lesson } from '../shared/types.js';

function repository(directory:string, files:Record<string,string|Buffer>) {
  const path=join(directory,'source');mkdirSync(path,{recursive:true});
  execFileSync('git',['init','--template=',path],{stdio:'ignore'});
  for(const [name,text] of Object.entries(files)) {mkdirSync(join(path,name,'..'),{recursive:true});writeFileSync(join(path,name),text);}
  execFileSync('git',['-C',path,'add','--all'],{stdio:'ignore'});
  execFileSync('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','fixture'],{stdio:'ignore'});
  return path;
}
function note(id:string,body:string):Lesson {
  const template=structuredClone(exampleLessons[0]);
  return {...template,id,title:id,summary:body,tags:[],sections:[{...template.sections[0],id:'paragraph',heading:'Paragraph',body,code:'',analogy:'',concepts:[]}]};
}
async function poll(check:()=>boolean) {for(let i=0;i<200;i++){if(check())return;await new Promise(done=>setTimeout(done,5));}throw new Error('condition timed out');}

test('repository index traverses nested commit files, excludes generated/binary/secret files, persists citations and immutable content',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-index-'));
  const dbPath=join(directory,'knowledge.sqlite');const cacheDir=join(directory,'cache');
  let service:KnowledgeService|undefined;
  try {
    const path=repository(directory,{'README.md':'Example repository\nStudy the calculator.','src/deep/calculator.ts':'export function add(a: number,b: number) {\n  return a + b;\n}\n','src/image.dat':Buffer.from([0,1,2]),'.env':'TOKEN=do-not-index','dist/bundle.js':'generated()','large.txt':'x'.repeat(300)});
    // Symlinks are committed but never followed. Untracked and dirty content is never read.
    symlinkSync('/etc/passwd',join(path,'shortcut'));
    execFileSync('git',['-C',path,'add','shortcut']);
    execFileSync('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','link'],{stdio:'ignore'});
    writeFileSync(join(path,'untracked.ts'),'this is untracked');writeFileSync(join(path,'README.md'),'uncommitted mutation');
    service=new KnowledgeService({dbPath,cacheDir,limits:{maxFileBytes:200}});
    const {repository:index}=service.createRepository({source:'local',path});await service.waitForIdle();
    const saved=service.repositories()[0];assert.equal(saved.state,'completed');assert.equal(saved.totalFiles,7);assert.equal(saved.indexedFiles,2);assert.equal(saved.skippedFiles,5);assert.match(saved.commit || '',/^[a-f0-9]{40}$/);
    assert.equal(service.status().embedding.state,'disabled');
    assert.equal(service.repositoryFile(index.id,'README.md').file.content,'Example repository\nStudy the calculator.');
    const results=await service.search('add',{repositoryId:index.id});assert.equal(results.mode,'keyword');assert.equal(results.results[0].path,'src/deep/calculator.ts');assert.equal(results.results[0].startLine,1);assert.equal(results.results[0].endLine,4);
    const source=await service.sourceForRepository(index.id,'calculator',new AbortController().signal);assert.match(source.content,/calculator\.ts:L1-L4/);assert.match(source.scope || '',/已遍歷 7/);
    await service.close();service=new KnowledgeService({dbPath,cacheDir});
    assert.equal(service.repositories()[0].commit,saved.commit);assert.equal((await service.search('add')).results.length,1);
    assert.throws(()=>service!.repositoryFile(index.id,'../outside'),/找不到/);
  } finally {await service?.close();rmSync(directory,{recursive:true,force:true});}
});

test('capacity limits are explicit and never reported as a complete text index',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-index-limit-'));
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache'),limits:{maxFiles:1}});
  try {
    const path=repository(directory,{'a.ts':'const alpha = 1;','b.ts':'const beta = 2;','c.ts':'const gamma = 3;'});
    const {repository:index}=service.createRepository({source:'local',path});await service.waitForIdle();
    const saved=service.repositories()[0];assert.equal(saved.totalFiles,3);assert.equal(saved.indexedFiles,1);assert.equal(saved.skippedFiles,2);assert.equal(saved.truncated,true);assert.match(saved.scope,/未完整收錄/);
    const source=await service.sourceForRepository(index.id,'alpha',new AbortController().signal);assert.equal(source.truncated,true);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('cosine vectors retrieve semantic matches without shared text and stale note vectors are deleted',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-vector-'));
  // Deterministic provider isolates the retrieval algorithm from downloads/network.
  const provider:EmbeddingProvider={model:'test-semantic-v1',embed:async texts=>texts.map(text=>/cooking|烹飪/.test(text)?[1,0,0]:/orbital|宇宙/.test(text)?[0,1,0]:[0,0,1])};
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache'),embeddingProvider:provider});
  try {
    service.upsertLesson(note('kitchen','The art of cooking delicious meals.'));service.upsertLesson(note('space','The orbital motion of a planet.'));await service.waitForIdle();
    assert.equal(service.status().embedding.dimensions,3);assert.equal(service.status().embedding.indexedChunks,2);
    const found=await service.search('烹飪');assert.equal(found.mode,'hybrid');assert.equal(found.results[0].ownerId,'kitchen');assert.equal(found.results[0].lexicalScore,0);assert.ok(found.results[0].semanticScore!>0.99);
    service.upsertLesson(note('kitchen','This paragraph is replaced.'));await service.waitForIdle();assert.equal((await service.search('烹飪')).results.length,0);
    service.deleteLesson('space');assert.equal(service.status().embedding.indexedChunks,1);assert.equal((await service.search('宇宙')).results.length,0);
    service.reconcileLessons([]);assert.equal(service.status().embedding.totalChunks,0);assert.equal(service.status().embedding.indexedChunks,0);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('a word glued to Chinese in a query is searched whole, not as letter pairs',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-keyword-'));
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache')});
  try {
    service.upsertLesson(note('python','Python 教學：從變數開始。'));
    service.upsertLesson(note('event-loop','The event loop runs one task on the stack, then the next one.'));
    await service.waitForIdle();
    assert.deepEqual([...new Set((await service.search('Python教學')).results.map(hit=>hit.ownerId))],['python']);
    const closure=(await service.search('Python閉包')).results.find(hit=>hit.ownerId==='python');
    assert.equal(closure?.lexicalScore,0.5);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('saved term explanations become searchable, survive restart, and leave no stale vectors when removed',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-annotation-index-'));
  const dbPath=join(directory,'k.sqlite'),cacheDir=join(directory,'cache');
  const provider:EmbeddingProvider={model:'annotation-test-v1',embed:async texts=>texts.map(text=>text.includes('指路牌')?[1,0]:[0,1])};
  let service=new KnowledgeService({dbPath,cacheDir,embeddingProvider:provider});
  try {
    const lesson=note('annotated-search','BFS 從起點逐層探索狀態。');
    service.upsertLesson(lesson);await service.waitForIdle();
    assert.equal((await service.search('指路牌')).results.length,0);
    lesson.annotations=[{id:'annotation-test',term:'BFS',sourceKey:'paragraph:body',quote:lesson.sections[0].body,
      explanation:'先探索距離起點最近的狀態，留下可以回家的指路牌。',analogy:'像漣漪一圈一圈向外。',example:'第 0 層 → 第 1 層 → 第 2 層',createdAt:new Date().toISOString()}];
    service.upsertLesson(lesson);await service.waitForIdle();
    const result=(await service.search('指路牌')).results[0];
    assert.ok(result);
    await service.close();service=new KnowledgeService({dbPath,cacheDir,embeddingProvider:provider});
    const saved=(await service.search('指路牌')).results[0];
    assert.equal(saved.ownerId,lesson.id);assert.equal(saved.sectionId,'paragraph');assert.match(saved.title,/詞句解釋：BFS/);
    lesson.annotations=[];service.upsertLesson(lesson);await service.waitForIdle();
    assert.equal((await service.search('指路牌')).results.length,0);
    assert.equal(service.status().embedding.totalChunks,1);
    assert.equal(service.status().embedding.indexedChunks,1);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('cancelled jobs retain checkpoints and retry finishes the same immutable commit',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-index-cancel-'));
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache')});
  try {
    const path=repository(directory,Object.fromEntries(Array.from({length:45},(_,i)=>[`src/${i}.ts`,`export const value${i}=${i};`])));
    const {job}=service.createRepository({source:'local',path});await poll(()=>service.repositories()[0].indexedFiles>0);
    service.cancelJob(job.id);await service.waitForIdle();const partial=service.repositories()[0];
    assert.equal(partial.state,'cancelled');assert.ok(partial.indexedFiles>0);assert.ok(partial.indexedFiles<45);
    service.retryJob(job.id);await service.waitForIdle();const finished=service.repositories()[0];
    assert.equal(finished.state,'completed');assert.equal(finished.indexedFiles,45);assert.equal(finished.commit,partial.commit);assert.equal(finished.chunks,45);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('interrupted jobs resume after service restart without re-reading mutable HEAD',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-index-resume-'));const dbPath=join(directory,'k.sqlite');const cacheDir=join(directory,'cache');
  let service:KnowledgeService|undefined;
  try {
    const path=repository(directory,Object.fromEntries(Array.from({length:35},(_,i)=>[`src/${i}.ts`,`const value${i}=${i};`])));
    service=new KnowledgeService({dbPath,cacheDir});service.createRepository({source:'local',path});await poll(()=>service!.repositories()[0].indexedFiles>0);
    const commit=service.repositories()[0].commit;await service.close();
    writeFileSync(join(path,'new-file.ts'),'New HEAD not included in old snapshot');execFileSync('git',['-C',path,'add','new-file.ts']);execFileSync('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','new-head'],{stdio:'ignore'});
    service=new KnowledgeService({dbPath,cacheDir});await service.waitForIdle();
    const finished=service.repositories()[0];assert.equal(finished.state,'completed');assert.equal(finished.commit,commit);assert.equal(finished.totalFiles,35);assert.equal(finished.indexedFiles,35);
  } finally {await service?.close();rmSync(directory,{recursive:true,force:true});}
});

test('previous running state is recovered, local subdirectory scope and non-GitHub transports are rejected',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-index-scope-'));const dbPath=join(directory,'k.sqlite');const cacheDir=join(directory,'cache');
  let service:KnowledgeService|undefined;
  try {
    const path=repository(directory,{'src/nested.ts':'const nested=1;'});service=new KnowledgeService({dbPath,cacheDir});
    for(const url of ['http://github.com/a/b','https://github.com/a/b/tree/main','https://example.com/a/b','file:///tmp/repo','https://token@github.com/a/b'])assert.throws(()=>service!.createRepository({source:'github',url}));
    service.createRepository({source:'local',path:join(path,'src')});await service.waitForIdle();assert.equal(service.jobs()[0].state,'failed');assert.match(service.jobs()[0].error || '',/根資料夾/);
    const job=service.createRepository({source:'local',path}).job;await service.waitForIdle();await service.close();
    const db=new DatabaseSync(dbPath);const record=JSON.parse(String(db.prepare('SELECT json FROM index_jobs WHERE id=?').get(job.id)?.json));record.state='running';db.prepare('UPDATE index_jobs SET json=? WHERE id=?').run(JSON.stringify(record),job.id);db.close();
    service=new KnowledgeService({dbPath,cacheDir});await service.waitForIdle();assert.equal(service.jobs().find(item=>item.id===job.id)?.state,'completed');
  } finally {await service?.close();rmSync(directory,{recursive:true,force:true});}
});

test('chunking preserves long lines and their original citation line',()=> {
  const content=`${'x'.repeat(2050)}\nsecond line\nthird line`;const chunks=chunkText(content,900);
  assert.equal(chunks.length,4);assert.deepEqual(chunks.slice(0,3).map(c=>[c.startLine,c.endLine]),[[1,1],[1,1],[1,1]]);assert.equal(chunks.slice(0,3).map(c=>c.text).join(''),'x'.repeat(2050));assert.equal(chunks[3].startLine,2);assert.equal(chunks[3].endLine,3);
});

function contextExcerpts(content:string) {
  return [...content.matchAll(/\n--- (.+):L(\d+)-L(\d+) @ ([a-f0-9]+) ---\n([\s\S]*?)(?=\n--- |$)/g)].map(match=>({path:match[1],startLine:Number(match[2]),endLine:Number(match[3]),commit:match[4],text:match[5].replace(/\n$/,'')}));
}

test('repository context protects complete small implementations from a long high-ranking report and respects a focused question',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-context-diversity-'));
  const question='專案架構、入口、主要資料流與模組關係';
  // Reproduce the original failure: broad cross-language retrieval strongly
  // favors report prose over C code. A focused query has a distinct vector.
  const provider:EmbeddingProvider={model:'context-fixture',embed:async texts=>texts.map(text=>text.includes('deep_report_needle')?[0,1]:text===question || text.includes('report.md')?[1,0]:[0.15,0.85])};
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache'),embeddingProvider:provider});
  try {
    const solver=Array.from({length:180},(_,i)=>`int solver_stage_${i}(int state) { return state + ${i}; } /* committed solver state transformation */`).join('\n');
    const mini=Array.from({length:35},(_,i)=>`int mini_step_${i}(int value) { return value + ${i}; }`).join('\n');
    const report=Array.from({length:320},(_,i)=>i===290?'deep_report_needle: the requested memory improvement is explained here.':`Report paragraph ${i}: detailed research prose about the project architecture, invariants, experiments, and alternatives. ${'additional observations '.repeat(2)}`).join('\n');
    const files={'README.md':Array.from({length:80},(_,i)=>`Project introduction ${i}. A documented solver and compact mini implementation. ${'Overview. '.repeat(3)}`).join('\n'),
      'report.md':report,'solver.c':solver,'mini.c':mini,'Makefile':'all: solver mini\nsolver: solver.c\n\tcc solver.c -o solver\nmini: mini.c\n\tcc mini.c -o mini\n',
      '.clang-format':'IndentWidth: 4\n','.gitignore':'solver\nmini\n','.github/workflows/ci.yml':'name: CI\non: push\n','LICENSE':'Fixture license.\n','tests/solutions.txt':'sample result\n'};
    const path=repository(directory,files);const {repository:index}=service.createRepository({source:'local',path});await service.waitForIdle();
    const results=await service.search(question,{repositoryId:index.id,limit:30});assert.equal(results.mode,'hybrid');assert.ok(results.results.every(hit=>hit.path==='report.md'));
    const source=await service.sourceForRepository(index.id,question,new AbortController().signal);
    const repeated=await service.sourceForRepository(index.id,question,new AbortController().signal);
    assert.equal(source.content,repeated.content,'selection must be deterministic');assert.ok(source.content.length<=42_000);
    const excerpts=contextExcerpts(source.content);const paths=new Set(excerpts.map(part=>part.path));
    for(const name of ['README.md','Makefile','solver.c','mini.c'])assert.ok(paths.has(name),`missing ${name}`);
    for(const name of ['solver.c','mini.c']){
      const expected=chunkText(files[name as 'solver.c'|'mini.c']);const actual=excerpts.filter(part=>part.path===name);
      assert.deepEqual(actual.map(({startLine,endLine,text})=>({startLine,endLine,text})),expected,`${name} should be retained in full, including middle and tail`);
    }
    assert.ok(excerpts.filter(part=>part.path==='report.md').reduce((total,part)=>total+part.text.length,0)<6000,'one report cannot dominate the context');
    assert.ok(excerpts.every(part=>part.commit===service.repositories()[0].commit));
    assert.match(source.scope || '',/文字檔選取 \d+\/\d+ 個精確引用分段/);assert.match(source.scope || '',/不代表逐行完整審閱/);assert.equal(source.truncated,true);
    const focused=await service.sourceForRepository(index.id,'deep_report_needle',new AbortController().signal);
    assert.match(focused.content,/deep_report_needle/);assert.match(focused.content,/Report paragraph 289:/);assert.match(focused.content,/Report paragraph 291:/);
    assert.ok(focused.content.length<=42_000);assert.match(focused.content,/solver\.c:L/);assert.match(focused.content,/mini\.c:L/);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('large source context retains adjacent middle and tail windows, focuses on a requested implementation and preserves exact citations',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-context-windows-'));
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache')});
  try {
    const lines=Array.from({length:800},(_,i)=>`int ${i===601?'requested_transition':'function_'+i}(int input) { return input + ${i}; } /* each original source line is independently identifiable ${i} */`);
    const content=lines.join('\n');const path=repository(directory,{'README.md':'A large C implementation.','solver.c':content,'mini.c':'int mini(void) { return 1; }','Makefile':'all: solver\n'});
    const {repository:index}=service.createRepository({source:'local',path});await service.waitForIdle();
    const broad=await service.sourceForRepository(index.id,'專案架構',new AbortController().signal);
    assert.ok(broad.content.length<=42_000);assert.match(broad.content,/function_400/);assert.match(broad.content,/function_799/);assert.match(broad.content,/mini\.c:L/);
    const focused=await service.sourceForRepository(index.id,'requested_transition',new AbortController().signal);
    assert.match(focused.content,/requested_transition/);assert.match(focused.content,/function_600/);assert.match(focused.content,/function_602/);assert.ok(focused.content.length<=42_000);
    for(const excerpt of contextExcerpts(focused.content).filter(part=>part.path==='solver.c'))assert.equal(excerpt.text,lines.slice(excerpt.startLine-1,excerpt.endLine).join('\n'));
    assert.equal(focused.truncated,true);assert.match(focused.scope || '',/不代表逐行完整審閱/);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});


test('documentation and unusual source files remain covered beside README when cross-language keyword retrieval has no hits',async()=> {
  const directory=mkdtempSync(join(tmpdir(),'bell-context-doc-fallback-'));
  const service=new KnowledgeService({dbPath:join(directory,'k.sqlite'),cacheDir:join(directory,'cache')});
  try {
    const files={
      'README.md':'English project introduction and overview.',
      'guide.md':Array.from({length:400},(_,i)=>`Guide paragraph ${i}: explain infrastructure setup, deployment and operational concepts in English.`).join('\n'),
      'tutorial.md':'A separate practical tutorial with a deployment walkthrough.',
      'infrastructure.tf':'resource "example_service" "demo" {\n  value = 42\n}',
    };
    const path=repository(directory,files);const {repository:index}=service.createRepository({source:'local',path});await service.waitForIdle();
    assert.equal(service.status().embedding.state,'disabled');
    const query='專案架構、入口、主要資料流與模組關係';
    const search=await service.search(query,{repositoryId:index.id,limit:30});assert.equal(search.mode,'keyword');assert.equal(search.results.length,0);
    const source=await service.sourceForRepository(index.id,query,new AbortController().signal);
    const excerpts=contextExcerpts(source.content);const paths=new Set(excerpts.map(part=>part.path));
    for(const name of Object.keys(files))assert.ok(paths.has(name),`README must not suppress ${name}`);
    assert.match(source.content,/example_service/);assert.match(source.content,/practical tutorial/);
    assert.ok(source.content.length<=42_000);assert.ok(excerpts.filter(part=>part.path==='guide.md').reduce((size,part)=>size+part.text.length,0)<6000);
    assert.ok(excerpts.every(part=>part.commit===service.repositories()[0].commit));assert.match(source.scope || '',/不代表逐行完整審閱/);
    assert.equal(source.content,(await service.sourceForRepository(index.id,query,new AbortController().signal)).content);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});
