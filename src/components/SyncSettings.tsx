import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Cloud, CloudOff, Database, GitCompareArrows, LoaderCircle, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { isLessonV3, type LessonNoteV3, type StoredLesson } from '../../shared/lesson-v3';
import type { SyncConflict, SyncResolution, SyncStatus } from '../../shared/sync';
import './sync-settings.css';

async function api<T>(path:string, method = 'GET', body?:unknown, signal?:AbortSignal):Promise<T> {
  const response = await fetch(`/api/sync${path}`,{method,signal,headers:{'content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '同步請求失敗，請稍後重試。');
  return data as T;
}
const formatDate = (value:string | null) => value ? new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '尚未完成第一次同步';

/** A format-3 version: its answer, then each step's point and explanation. */
function ConflictVersionV3({label,lesson}:{label:string;lesson:LessonNoteV3}) {
  return <div className="bell-sync-version">
    <div className="bell-sync-version-label">{label}<span>{lesson.favorite ? '已收藏' : '未收藏'}</span></div>
    <strong>{lesson.title}</strong><p>{lesson.answer}</p>
    <small>{lesson.steps.length} 步 · {lesson.category}</small>
    <details><summary>展開此版本內容</summary><div className="bell-sync-version-content">
      {lesson.steps.map(step => <section key={step.id}><h5>{step.lead}</h5><p>{step.body}</p></section>)}
      <small>來源：{lesson.source.label}</small>
    </div></details>
  </div>;
}

function ConflictVersion({label,lesson}:{label:string;lesson:StoredLesson | null}) {
  if (lesson && isLessonV3(lesson)) return <ConflictVersionV3 label={label} lesson={lesson}/>;
  return <div className={`bell-sync-version ${!lesson ? 'is-deleted' : ''}`}>
    <div className="bell-sync-version-label">{label}<span>{lesson ? lesson.favorite ? '已收藏' : '未收藏' : '已刪除'}</span></div>
    {lesson ? <>
      <strong>{lesson.title}</strong><p>{lesson.summary}</p>
      <small>{lesson.sections.length} 個段落 · {lesson.category}</small>
      <details><summary>展開此版本內容</summary><div className="bell-sync-version-content">
        {lesson.sections.map(section => <section key={section.id}>
          <h5>{section.heading}</h5><p>{section.body}</p><p className="bell-sync-analogy">{section.analogy}</p>
          {section.codeExample && <><h5>小完整案例：{section.codeExample.title}</h5><p><strong>使用情境：</strong>{section.codeExample.scenario}</p><p><strong>執行環境：</strong>{section.codeExample.environment}</p></>}
          {section.code && <pre>{section.code}</pre>}
          {section.codeExample && <>
            <h5>逐段白話解說</h5>
            <ol>{section.codeExample.walkthrough.map((step,index) => <li key={index}>第 {step.startLine}{step.endLine !== step.startLine ? `–${step.endLine}` : ''} 行：{step.explanation}</li>)}</ol>
            <h5>預期輸出（依程式推導，未執行）</h5><pre>{section.codeExample.expectedOutput}</pre>
            <p><strong>實際應用：</strong>{section.codeExample.application}</p>
          </>}
        </section>)}
        <section><h5>動畫解說</h5><p>{lesson.visual.caption}</p>{lesson.visual.steps.map((step,index) => <p key={index}>{index + 1}. {step.title}：{step.description}</p>)}</section>
        <small>來源：{lesson.source.label}</small>
      </div></details>
    </> : <p>此版本已將筆記刪除。採用這個版本會保留刪除狀態。</p>}
  </div>;
}

export default function SyncSettings({onRemoteChange}:{onRemoteChange?:()=>void}) {
  const [status,setStatus] = useState<SyncStatus | null>(null);
  const [conflicts,setConflicts] = useState<SyncConflict[]>([]);
  const [remoteUrl,setRemoteUrl] = useState('');const [token,setToken] = useState('');const [consent,setConsent] = useState(false);
  const [busy,setBusy] = useState<string | null>(null);const [error,setError] = useState('');const [message,setMessage] = useState('');
  const mounted = useRef(true);const callback = useRef(onRemoteChange);const busyRef = useRef(false);const lastSync = useRef<string | null>(null);const loaded = useRef(false);
  callback.current = onRemoteChange;
  const refresh = useCallback(async (signal?:AbortSignal) => {
    const [next,items] = await Promise.all([api<SyncStatus>('/status','GET',undefined,signal),api<SyncConflict[]>('/conflicts','GET',undefined,signal)]);
    if (!mounted.current || signal?.aborted) return;
    setStatus(next);setConflicts(items);
    if (!loaded.current && next.remoteUrl) setRemoteUrl(next.remoteUrl);
    if (loaded.current && next.lastSyncedAt && next.lastSyncedAt !== lastSync.current) callback.current?.();
    loaded.current = true;lastSync.current = next.lastSyncedAt;
  },[]);
  useEffect(() => {
    mounted.current = true;const controller = new AbortController();
    void refresh(controller.signal).catch(() => {if (!controller.signal.aborted) setError('無法取得同步狀態，請確認本機服務仍在執行。');});
    const timer = setInterval(() => {if (!busyRef.current) void refresh(controller.signal).catch(() => {});},4000);
    return () => {mounted.current = false;controller.abort();clearInterval(timer);};
  },[refresh]);
  const run = async (name:string,operation:()=>Promise<void>) => {
    if (busyRef.current) return;busyRef.current = true;setBusy(name);setError('');setMessage('');
    try {await operation();}
    catch (err) {if (mounted.current) setError(err instanceof Error ? err.message : '同步暫時無法完成；筆記仍保留在本機。');}
    finally {
      try {await refresh();} catch { /* Preserve the more specific action error. */ }
      busyRef.current = false;if (mounted.current) setBusy(null);
    }
  };
  const connect = (event:FormEvent) => {
    event.preventDefault();if (!consent) return;
    void run('connect',async () => {
      await api<SyncStatus>('/connect','POST',{remoteUrl:remoteUrl.trim(),token,uploadExisting:true});
      if (mounted.current) {setToken('');setMessage('已連線。之後會自動同步筆記變更。');}callback.current?.();
    });
  };
  const resolve = (id:string,strategy:SyncResolution) => void run(`resolve-${id}`,async () => {
    await api(`/conflicts/${encodeURIComponent(id)}/resolve`,'POST',{strategy});
    if (mounted.current) setMessage(strategy === 'both' ? '已保留雲端版本，並將本機內容另存為副本。' : '已套用你選擇的版本。');callback.current?.();
  });
  const ready = remoteUrl.trim().length > 0 && token.length >= 32 && !/\s/.test(token);
  return <div className="bell-sync-settings">
    <div className="bell-sync-intro"><span className="bell-sync-intro-icon"><Cloud size={25}/></span><div><h3>讓知識隨裝置同行</h3><p>連接你自己的同步服務，把筆記、收藏與教學動畫帶到其他裝置。</p></div></div>
    {error && <div className="bell-sync-notice is-error" role="alert">{error}</div>}
    {message && <div className="bell-sync-notice is-success" role="status"><CheckCircle2 size={16}/>{message}</div>}
    {!status ? <div className="bell-sync-loading"><LoaderCircle size={17} className="bell-sync-spin"/>正在讀取同步設定…</div> : <>
      <section className="bell-sync-status-card" aria-label="雲端同步狀態">
        <div className="bell-sync-status-heading"><div className={`bell-sync-state ${status.configured && !status.lastError ? 'is-connected' : ''}`}>{status.configured && !status.lastError ? <CheckCircle2 size={16}/> : <CloudOff size={16}/>}<strong>{status.configured ? status.syncing ? '正在同步' : status.lastError ? '等待重試' : '已連線' : '尚未連線'}</strong></div>{status.configured && <span className="bell-sync-pill">自動同步已啟用</span>}</div>
        {status.configured ? <>
          <p className="bell-sync-address">{status.remoteUrl}</p>
          <div className="bell-sync-metrics"><div><strong>{status.pending}</strong><span>待同步變更</span></div><div className={status.conflicts ? 'has-conflict' : ''}><strong>{status.conflicts}</strong><span>待處理衝突</span></div><div><small>上次同步</small><span>{formatDate(status.lastSyncedAt)}</span></div></div>
          {status.lastError && <p className="bell-sync-inline-error" role="status">{status.lastError}</p>}
          <div className="bell-sync-actions"><button type="button" className="bell-sync-button primary" disabled={Boolean(busy) || status.syncing} onClick={() => void run('sync',async () => {await api('/run','POST');if (mounted.current) setMessage('同步完成。');callback.current?.();})}>{busy === 'sync' || status.syncing ? <LoaderCircle className="bell-sync-spin" size={16}/> : <RefreshCw size={16}/>}立即同步</button><button type="button" className="bell-sync-button subtle" disabled={Boolean(busy)} onClick={() => void run('disconnect',async () => {await api('/connection','DELETE');if (mounted.current) {setToken('');setConsent(false);setMessage('已中斷連線。本機和雲端筆記都已保留。');}})}><Unplug size={16}/>中斷連線</button></div>
          <p className="bell-sync-footnote">本機服務啟動時會自動同步；離線變更會保留，恢復連線後繼續。</p>
        </> : <p className="bell-sync-footnote">目前筆記只儲存在這台裝置。尚未部署或連接任何雲端服務。</p>}
      </section>
      {conflicts.length > 0 && <section className="bell-sync-conflicts" aria-label="同步衝突">
        <div className="bell-sync-section-title"><GitCompareArrows size={19}/><div><h4>有 {conflicts.length} 篇筆記需要你決定</h4><p>兩邊都曾修改，原有內容已保留。請比較後選擇要採用的版本。</p></div></div>
        {conflicts.map(conflict => <article className="bell-sync-conflict" key={conflict.id}>
          <div className="bell-sync-versions"><ConflictVersion label="這台裝置" lesson={conflict.local}/><ConflictVersion label="雲端版本" lesson={conflict.remote}/></div>
          <div className="bell-sync-actions"><button type="button" className="bell-sync-button" disabled={Boolean(busy)} onClick={() => resolve(conflict.id,'local')}>{conflict.local ? '採用本機版本' : '採用本機刪除'}</button><button type="button" className="bell-sync-button" disabled={Boolean(busy)} onClick={() => resolve(conflict.id,'remote')}>{conflict.remote ? '採用雲端版本' : '採用雲端刪除'}</button><button type="button" className="bell-sync-button primary" disabled={Boolean(busy)} onClick={() => resolve(conflict.id,'both')}>{busy === `resolve-${conflict.id}` && <LoaderCircle size={15} className="bell-sync-spin"/>}保留兩者</button></div>
          <p className="bell-sync-footnote">保留兩者會採用雲端狀態，並將仍存在的本機內容另存副本。</p>
        </article>)}
      </section>}
      <form className="bell-sync-form" onSubmit={connect}>
        <div className="bell-sync-section-title"><Database size={18}/><div><h4>{status.configured ? '更新同步連線' : '連接同步服務'}</h4><p>使用自己的伺服器與工作區憑證。</p></div></div>
        <label htmlFor="bell-sync-url">同步服務網址<input id="bell-sync-url" type="url" value={remoteUrl} onChange={event => {setRemoteUrl(event.target.value);setMessage('');}} placeholder="https://sync.example.com" required autoComplete="url" spellCheck={false} disabled={Boolean(busy)}/></label>
        <label htmlFor="bell-sync-token">工作區憑證<input id="bell-sync-token" type="password" value={token} onChange={event => {setToken(event.target.value);setMessage('');}} placeholder={status.configured ? '更新連線時，請重新輸入憑證' : '至少 32 個字元'} minLength={32} maxLength={4096} autoComplete="off" spellCheck={false} disabled={Boolean(busy)}/></label>
        <div className="bell-sync-secret-note"><ShieldCheck size={15}/><span>憑證只交給本機後端保存，不會顯示已儲存的值。</span></div>
        <label className="bell-sync-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={Boolean(busy)}/><span>連線後將本機筆記同步至此服務<small>包含貼上的來源、教學內容與收藏。相同憑證的裝置可存取整個知識庫。</small></span></label>
        <div className="bell-sync-actions"><button type="button" className="bell-sync-button" disabled={!ready || Boolean(busy)} onClick={() => void run('test',async () => {await api('/test','POST',{remoteUrl:remoteUrl.trim(),token});if (mounted.current) setMessage('連線測試成功，尚未上傳筆記。');})}>{busy === 'test' ? <LoaderCircle size={16} className="bell-sync-spin"/> : <Check size={16}/>}測試連線</button><button type="submit" className="bell-sync-button primary" disabled={!ready || !consent || Boolean(busy)}>{busy === 'connect' ? <LoaderCircle size={16} className="bell-sync-spin"/> : <Cloud size={16}/>}連線並同步</button></div>
      </form>
      <aside className="bell-sync-guide"><div><h4>還沒有同步服務？</h4><p>專案附有可自行部署的 Docker 同步伺服器與 HTTPS 設定。本機測試可使用 http://127.0.0.1:8787。</p><a href="/api/sync/guide" target="_blank" rel="noreferrer">閱讀部署指南<ArrowUpRight size={15}/></a></div><Cloud size={34} aria-hidden="true"/></aside>
    </>}
  </div>;
}
