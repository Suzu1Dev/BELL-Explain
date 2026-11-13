import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, FileCode2, FolderGit2, GitBranch, LoaderCircle, RefreshCw, Search, Square, Terminal, Trash2 } from 'lucide-react';
import type { IndexJob, RepositoryFile, RepositoryIndex } from '../../shared/knowledge';
import CodeBlock from './CodeBlock';
import './repository-workspace.css';

async function request<T>(path:string,init?:RequestInit):Promise<T> {
  const response=await fetch(`/api/knowledge${path}`,init);
  if(response.status===204)return undefined as T;
  const body=await response.json();if(!response.ok)throw new Error(body.error || '無法讀取知識索引。');return body;
}
const stateLabel={queued:'等待中',running:'索引中',completed:'已索引',cancelled:'已取消',failed:'未完成'};
const json=(body:unknown):RequestInit=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
type FileDetail={file:RepositoryFile & {content:string|null};chunks:Array<{id:string;text:string;startLine:number;endLine:number}>};

export default function RepositoryWorkspace({onExplain,initialRepositoryId}:{onExplain:(repoId:string,url:string,question:string)=>void;initialRepositoryId?:string}) {
  const [source,setSource]=useState<'github'|'local'>('github');const [location,setLocation]=useState('');
  const [repositories,setRepositories]=useState<RepositoryIndex[]>([]);const [jobs,setJobs]=useState<IndexJob[]>([]);
  const [selectedId,setSelectedId]=useState(initialRepositoryId || '');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [confirmDelete,setConfirmDelete]=useState(false);const [managementAction,setManagementAction]=useState<'update'|'delete'|null>(null);
  const [files,setFiles]=useState<RepositoryFile[]>([]);const [fileCount,setFileCount]=useState(0);const [offset,setOffset]=useState(0);const [filter,setFilter]=useState('');
  const [selectedFile,setSelectedFile]=useState<string|null>(null);const [detail,setDetail]=useState<FileDetail|null>(null);const [fileLoading,setFileLoading]=useState(false);const [question,setQuestion]=useState('');
  const selected=repositories.find(repo=>repo.id===selectedId);const currentJob=jobs.find(job=>job.repositoryId===selectedId);
  const hasActiveJobs=jobs.some(job=>job.state==='queued'||job.state==='running');
  const fileSequence=useRef(0);
  const mutationLock=useRef(false);
  const sameSourceRunning=Boolean(selected && repositories.some(repo=>repo.source===selected.source && repo.location===selected.location && ['queued','running'].includes(repo.state)));
  const refresh=useCallback(async(signal?:AbortSignal)=> {
    const [nextRepos,nextJobs]=await Promise.all([request<RepositoryIndex[]>('/repositories',{signal}),request<IndexJob[]>('/jobs',{signal})]);
    setRepositories(nextRepos);setJobs(nextJobs);setSelectedId(previous=>previous || nextRepos[0]?.id || '');
    return nextJobs.some(job=>job.state==='queued'||job.state==='running');
  },[]);
  useEffect(()=> {
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=> {try{const active=await refresh(controller.signal);if(!controller.signal.aborted && active)timer=setTimeout(load,1500);}catch(cause){if(!controller.signal.aborted){setError(cause instanceof Error?cause.message:'索引服務無法回應。');timer=setTimeout(load,5000);}}};
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[refresh,hasActiveJobs]);
  useEffect(()=>{if(initialRepositoryId)setSelectedId(initialRepositoryId);},[initialRepositoryId]);
  useEffect(()=>{++fileSequence.current;setOffset(0);setSelectedFile(null);setDetail(null);setFileLoading(false);setQuestion('');setConfirmDelete(false);},[selectedId]);
  useEffect(()=> {
    if(!selectedId)return;const controller=new AbortController();
    const timer=setTimeout(()=> {
      const params=new URLSearchParams({limit:'200',offset:String(offset),q:filter});
      request<{files:RepositoryFile[];total:number}>(`/repositories/${encodeURIComponent(selectedId)}/files?${params}`,{signal:controller.signal}).then(value=>{setFiles(value.files);setFileCount(value.total);}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
    },150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[selectedId,offset,filter,selected?.indexedFiles,selected?.skippedFiles]);
  async function create(event:React.FormEvent) {
    event.preventDefault();if(mutationLock.current)return;mutationLock.current=true;setBusy(true);setError('');
    const trimmed=location.trim().replace(/\/$/,'');const normalized=source==='github'?trimmed.replace(/\.git$/,''):trimmed;
    const active=repositories.find(repo=>repo.source===source && repo.location.replace(/\/$/,'')===normalized && ['queued','running'].includes(repo.state));
    if(active){setSelectedId(active.id);setError('這個來源已有索引工作進行中，已切換到該工作。');mutationLock.current=false;setBusy(false);return;}
    try {const result=await request<{repository:RepositoryIndex}>('/repositories',json(source==='github'?{source,url:location.trim()}:{source,path:location.trim()}));setSelectedId(result.repository.id);setLocation('');await refresh();}
    catch(cause){setError(cause instanceof Error?cause.message:'無法建立索引。');}finally{mutationLock.current=false;setBusy(false);}
  }
  async function updateVersion() {
    if(!selected || mutationLock.current || sameSourceRunning)return;
    mutationLock.current=true;setBusy(true);setManagementAction('update');setError('');
    try {
      const input=selected.source==='github'?{source:'github',url:selected.location}:{source:'local',path:selected.location};
      const result=await request<{repository:RepositoryIndex}>('/repositories',json(input));
      setSelectedId(result.repository.id);setConfirmDelete(false);await refresh();
    } catch(cause){setError(cause instanceof Error?cause.message:'無法建立新版本索引。');}
    finally{mutationLock.current=false;setBusy(false);setManagementAction(null);}
  }
  async function removeIndex() {
    if(!selected || mutationLock.current)return;
    mutationLock.current=true;setBusy(true);setManagementAction('delete');setError('');
    try {
      await request(`/repositories/${encodeURIComponent(selected.id)}`,{method:'DELETE'});
      ++fileSequence.current;setSelectedId('');setSelectedFile(null);setDetail(null);setFiles([]);setFileCount(0);setQuestion('');setConfirmDelete(false);
      await refresh();
    } catch(cause){setError(cause instanceof Error?cause.message:'無法移除此索引。');}
    finally{mutationLock.current=false;setBusy(false);setManagementAction(null);}
  }
  async function action(jobId:string,action:'cancel'|'retry') {
    setError('');try{await request(`/jobs/${encodeURIComponent(jobId)}/${action}`,json({}));await refresh();}catch(cause){setError(cause instanceof Error?cause.message:'工作操作失敗。');}
  }
  async function openFile(path:string) {
    const sequence=++fileSequence.current;setSelectedFile(path);setDetail(null);setFileLoading(true);setError('');
    try{const value=await request<FileDetail>(`/repositories/${encodeURIComponent(selectedId)}/file?${new URLSearchParams({path})}`);if(sequence===fileSequence.current)setDetail(value);}
    catch(cause){if(sequence===fileSequence.current)setError(cause instanceof Error?cause.message:'無法讀取檔案。');}finally{if(sequence===fileSequence.current)setFileLoading(false);}
  }
  function selectRepository(id:string){++fileSequence.current;setSelectedId(id);setFiles([]);setFileCount(0);setFilter('');setError('');}
  function explain(event:React.FormEvent){event.preventDefault();if(!selected)return;onExplain(selected.id,selected.source==='github'?selected.location:'',`${selectedFile?`請解釋檔案 ${selectedFile}。\n`:''}${question.trim() || '請解釋這個 repository 的架構、主要執行流程與核心概念，並標出來源檔案與行號。'}`);}
  const processed=currentJob?.processedFiles || 0;const total=currentJob?.totalFiles || 0;
  return <section className="repository-workspace">
    <div className="repo-page-heading"><div><h1>Repo 索引</h1></div></div>
    <form className="repo-import" onSubmit={create}>
      <div className="repo-source-tabs" role="group" aria-label="索引來源"><button type="button" className={source==='github'?'selected':''} onClick={()=>setSource('github')}><GitBranch size={15}/>公開 GitHub</button><button type="button" className={source==='local'?'selected':''} onClick={()=>setSource('local')}><Terminal size={15}/>本機 Repo</button></div>
      <label className="repo-location-label" htmlFor="repo-location">{source==='github'?'公開專案根網址':'授權讀取的 repository 根資料夾（絕對路徑）'}</label>
      <div className="repo-import-row"><input id="repo-location" value={location} onChange={event=>setLocation(event.target.value)} placeholder={source==='github'?'https://github.com/owner/repository':'/Users/your-name/Projects/my-repo'} required autoComplete="off" spellCheck={false}/><button className="knowledge-primary" type="submit" disabled={busy || !location.trim()}>{busy?<LoaderCircle size={16} className="knowledge-spin"/>:<FolderGit2 size={16}/>}建立索引</button></div>
      <p className="repo-scope-hint">只索引已提交的檔案</p>
    </form>
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    {!repositories.length?<div className="repo-empty"><GitBranch size={28}/><h2>還沒有索引的 Repo</h2></div>:<div className="repo-layout">
      <nav className="repo-list" aria-label="已建立的 repository">{repositories.map(repo=><button disabled={busy} className={`repo-card ${repo.id===selectedId?'selected':''}`} key={repo.id} onClick={()=>selectRepository(repo.id)}><span className="repo-card-top"><GitBranch size={16}/><strong>{repo.label}</strong><i className={`repo-state ${repo.state}`}>{stateLabel[repo.state]}</i></span><span>{repo.indexedFiles.toLocaleString()} 個文字檔 · {repo.chunks.toLocaleString()} 個分段</span>{repo.commit && <code>{repo.commit.slice(0,10)}{repo.truncated?' · 範圍有限':''}</code>}</button>)}</nav>
      {selected && <div className="repo-detail">
        <div className="repo-detail-heading"><div><h2>{selected.label}</h2><p title={selected.location}>{selected.location}</p></div><span className={`repo-state ${selected.state}`}>{selected.state==='completed'?<Check size={13}/>:null}{stateLabel[selected.state]}</span></div>
        <div className="repo-management"><button disabled={busy || sameSourceRunning} onClick={()=>void updateVersion()} title={sameSourceRunning?'相同來源已有索引工作，請等待完成。':'讀取來源目前的 HEAD，另外建立索引並保留舊版本。'}>{managementAction==='update'?<LoaderCircle size={13} className="knowledge-spin"/>:<RefreshCw size={13}/>}更新版本</button><button className="repo-remove-button" disabled={busy} onClick={()=>setConfirmDelete(value=>!value)} aria-expanded={confirmDelete}><Trash2 size={13}/>移除此索引</button><span>更新會保留舊 commit，另外建立最新版本的索引。</span></div>
        {confirmDelete && <div className="repo-delete-confirm" role="group" aria-label="確認移除 repository 索引"><strong>移除「{selected.label}」的這個索引版本？</strong><p>會刪除此版本的檔案、搜尋分段與向量快取；進行中的索引工作也會取消。已儲存的教學筆記及其中的來源快照會保留。其他 commit 版本不受影響。</p><div><button disabled={busy} onClick={()=>setConfirmDelete(false)}>保留索引</button><button className="repo-confirm-remove" disabled={busy} onClick={()=>void removeIndex()}>{managementAction==='delete'?<LoaderCircle size={13} className="knowledge-spin"/>:<Trash2 size={13}/>}確認移除</button></div></div>}
        {currentJob && <div className="repo-job" aria-live="polite"><div><span>{currentJob.state==='running' && <LoaderCircle size={14} className="knowledge-spin"/>}{currentJob.phase}</span><span>{processed.toLocaleString()} / {total.toLocaleString()}</span></div><progress value={total?processed:undefined} max={total || 1} aria-label="Repository 索引進度"/><div className="repo-job-actions">{['queued','running'].includes(currentJob.state) && <button onClick={()=>void action(currentJob.id,'cancel')}><Square size={12}/>取消</button>}{['failed','cancelled'].includes(currentJob.state) && <button onClick={()=>void action(currentJob.id,'retry')}><RefreshCw size={13}/>從保存進度繼續</button>}{currentJob.error && <p className="knowledge-error">{currentJob.error}</p>}</div></div>}
        <div className="repo-metrics"><div><strong>{selected.totalFiles.toLocaleString()}</strong><span>檔案樹項目</span></div><div><strong>{selected.indexedFiles.toLocaleString()}</strong><span>已索引文字檔</span></div><div><strong>{selected.skippedFiles.toLocaleString()}</strong><span>已排除</span></div><div><strong>{selected.chunks.toLocaleString()}</strong><span>可引用分段</span></div></div>
        <details className="repo-scope" open={selected.truncated}><summary>索引範圍與限制{selected.truncated?' · 部分文字檔未收錄':''}</summary><p>{selected.scope}</p>{selected.commit && <code>Commit: {selected.commit}</code>}<p>每個專案最多 10,000 個合格檔案、50 MB 文字與 60,000 分段；每檔最多 250 KB。索引完成後，AI 會依問題取出相關段落，來源筆記會保留實際使用範圍。</p></details>
        <div className="repo-file-browser"><div className="repo-file-list"><label className="repo-file-filter"><Search size={14}/><input aria-label="搜尋全部索引檔案路徑" placeholder="搜尋檔案路徑…" value={filter} onChange={event=>{setFilter(event.target.value);setOffset(0);}}/></label><div className="repo-file-scroll">{files.map(file=><button key={file.path} className={selectedFile===file.path?'selected':''} onClick={()=>void openFile(file.path)} title={`${file.path}${file.reason?` · ${file.reason}`:''}`}><FileCode2 size={14}/><span>{file.path}</span><i className={`file-state ${file.state}`}>{file.state==='indexed'?'已收錄':file.state==='skipped'?'排除':'等待'}</i></button>)}{!files.length && <p className="repo-muted">{selected.state==='queued'||selected.state==='running'?'檔案樹讀取中…':'沒有符合的檔案。'}</p>}</div><div className="repo-pagination"><button aria-label="上一頁檔案" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-200))}><ChevronLeft size={16}/></button><span>{fileCount?`${offset+1}–${Math.min(offset+files.length,fileCount)} / ${fileCount}`:'0 個檔案'}</span><button aria-label="下一頁檔案" disabled={offset+200>=fileCount} onClick={()=>setOffset(offset+200)}><ChevronRight size={16}/></button></div></div>
          <div className="repo-file-preview">{fileLoading?<div className="repo-empty"><LoaderCircle className="knowledge-spin" size={20}/><p>讀取 commit 中的檔案…</p></div>:detail?<><div className="repo-file-meta"><strong>{detail.file.path}</strong><span>{(detail.file.bytes/1000).toFixed(1)} KB · {detail.file.chunks} 個分段</span></div>{detail.file.content!==null?<><CodeBlock code={detail.file.content} filename={detail.file.path}/><p className="repo-citations">引用範圍：{detail.chunks.map(chunk=>`L${chunk.startLine}–L${chunk.endLine}`).join('、') || '空白檔案沒有文字分段'}</p></>:<p className="repo-excluded">{detail.file.reason || '此檔案仍在等待索引。'}</p>}</>:<div className="repo-empty"><FileCode2 size={28}/><p>選擇檔案，核對實際內容與行號。</p></div>}</div></div>
        <form className="repo-question" onSubmit={explain}><label htmlFor="repo-question">{selectedFile?`深入理解 ${selectedFile}`:'你想先讀懂哪一部分？'}</label><textarea id="repo-question" value={question} onChange={event=>setQuestion(event.target.value)} placeholder="例如：從使用者送出請求開始，資料經過哪些函式？請搭配動畫解釋。" rows={3} maxLength={2000}/><div><span>{selected.state==='completed'?'會使用此 commit 中可引用的分段，生成完整教學筆記。':'索引完成後即可生成教學筆記。'}</span><button type="submit" className="knowledge-primary" disabled={selected.state!=='completed' || selected.chunks===0}>開始解說<ArrowRight size={15}/></button></div></form>
      </div>}
    </div>}
  </section>;
}
