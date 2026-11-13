import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import type { KnowledgeStatus } from '../../shared/knowledge';
import './semantic-search.css';

export default function EmbeddingSettings() {
  const [status,setStatus]=useState<KnowledgeStatus|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const refresh=useCallback(async(signal?:AbortSignal)=> {
    const response=await fetch('/api/knowledge/status',{signal});const value=await response.json();if(!response.ok)throw new Error(value.error || '向量服務無法回應。');setStatus(value as KnowledgeStatus);return value as KnowledgeStatus;
  },[]);
  useEffect(()=> {
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=> {try{const value=await refresh(controller.signal);if(!controller.signal.aborted && value.embedding.state==='loading')timer=setTimeout(load,1500);}catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'向量服務無法回應。');}};
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[refresh,status?.embedding.state]);
  async function change(action:'local'|'api'|'rebuild') {
    setBusy(true);setError('');
    try{const response=await fetch(`/api/knowledge/embeddings/${action==='rebuild'?'rebuild':'enable'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='rebuild'?{}:{provider:action})});const value=await response.json();if(!response.ok)throw new Error(value.error || '無法更新向量設定。');setStatus(value);}
    catch(cause){setError(cause instanceof Error?cause.message:'無法更新向量設定。');}finally{setBusy(false);}
  }
  const embedding=status?.embedding;const loading=embedding?.state==='loading';
  return <section className="embedding-settings" aria-label="語意向量搜尋設定">
    <div className="embedding-title"><span><Sparkles size={17}/><strong>多語語意搜尋</strong></span><i className={embedding?.state==='ready'?'ready':''}>{loading?<><LoaderCircle size={12} className="semantic-spin"/>建立中</>:embedding?.state==='ready'?<><CheckCircle2 size={12}/>已啟用</>:embedding?.state==='error'?'需要重試':'尚未啟用'}</i></div>
    <p>將筆記段落與 Repo 程式碼轉成真正的語意向量，讓「不同說法、相同概念」也能連在一起。搜尋會結合向量相似度與關鍵字，並保留原文引用。</p>
    {!embedding?.enabled && <p className="embedding-download">第一次啟用會下載約 120–150 MB 的多語模型，可能需要數分鐘。之後在本機計算並快取模型；筆記內容不會因本機向量功能而傳送到雲端。</p>}
    {embedding?.enabled && <div className="embedding-progress"><div><span>{embedding.provider==='local'?'本機 CPU 模型':embedding.provider==='api'?'Embeddings API':'自訂向量模型'}</span><strong>{embedding.indexedChunks.toLocaleString()} / {embedding.totalChunks.toLocaleString()} 個分段</strong></div><progress value={embedding.indexedChunks} max={embedding.totalChunks || 1} aria-label="向量建立進度"/><code>{embedding.model}</code>{embedding.dimensions && <span>{embedding.dimensions} 維向量 · SQLite 持久儲存</span>}{loading && <p>正在準備模型或建立向量，期間仍可使用關鍵字搜尋。可關閉這個視窗，工作會繼續。</p>}</div>}
    {(error || embedding?.error) && <p className="embedding-error" role="alert">{error || embedding?.error}</p>}
    <div className="embedding-actions">{(!embedding?.enabled || embedding.provider!=='local') && <button className="embedding-enable" disabled={busy || loading || !status} onClick={()=>void change('local')}><Download size={14}/>啟用本機語意模型</button>}{embedding?.enabled && <button disabled={busy || loading} onClick={()=>void change('rebuild')}><RefreshCw size={13}/>重建向量</button>}</div>
    <details className="embedding-api"><summary>改用 OpenAI 相容的 Embeddings API</summary><p>在伺服器 .env 設定 <code>EMBEDDING_API_KEY</code>、<code>EMBEDDING_MODEL</code> 與選填的 <code>EMBEDDING_BASE_URL</code>（預設 https://api.openai.com/v1）。設定後重新啟動，再按下方按鈕。這個選項會將已收錄的筆記與程式碼段落送往你設定的 API，並可能產生費用；與 Codex 教學模型分開設定。</p><button disabled={busy || loading || !status} onClick={()=>void change('api')}>使用已設定的向量 API</button></details>
  </section>;
}
