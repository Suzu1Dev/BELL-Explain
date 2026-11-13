import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, FileCode2, LoaderCircle, Search, Sparkles } from 'lucide-react';
import type { KnowledgeSearch } from '../../shared/knowledge';
import {
  formatSimilarityBadge,
  localizeSemanticWarning,
  parseLessonChunkTitle,
  semanticSearchCopy,
} from '../copy/practical-search';
import MathText from './MathText';
import './semantic-search.css';

// Note chunk titles from server/knowledge.ts carry note/section math in the prefix
// and raw explanation terms or attached filenames in the suffix.
export function lessonTitle(title:string) {
  const {baseTitle,suffix}=parseLessonChunkTitle(title);
  return suffix===null?<MathText text={baseTitle}/>:<><MathText text={baseTitle}/>{suffix}</>;
}

export default function SemanticSearch({query,onOpen,onRepository,excludeLessonId,compact=false}:{query:string;onOpen:(lessonId:string,sectionId?:string)=>void;onRepository?:(repoId:string)=>void;excludeLessonId?:string;compact?:boolean}) {
  const copy=semanticSearchCopy();
  const [result,setResult]=useState<KnowledgeSearch|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
  useEffect(()=> {
    setResult(null);setError('');
    if(!query.trim()){setLoading(false);return;}
    const controller=new AbortController();setLoading(true);
    const timer=setTimeout(async()=> {
      const unavailableError=semanticSearchCopy().searchUnavailableError;
      try {
        const params=new URLSearchParams({q:query.trim().slice(0,2000),limit:compact?'4':'12',...(excludeLessonId?{excludeLessonId}:{})});
        const response=await fetch(`/api/knowledge/search?${params}`,{signal:controller.signal});const body=await response.json();
        if(!response.ok)throw new Error(body.error || unavailableError);
        if(!controller.signal.aborted)setResult(body);
      } catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:unavailableError);}
      finally{if(!controller.signal.aborted)setLoading(false);}
    },compact?500:320);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,excludeLessonId,compact]);
  if(!query.trim())return null;
  const warning=localizeSemanticWarning(result?.warning);
  return <section className={`semantic-search ${compact?'compact':''}`} aria-label={compact?copy.compactRegionAria:copy.regionAria}>
    <div className="semantic-heading"><span>{compact?<Sparkles size={15} aria-hidden="true"/>:<Search size={16} aria-hidden="true"/>}<strong>{compact?copy.compactHeading:copy.heading}</strong></span>{loading?<LoaderCircle className="semantic-spin" size={14} aria-hidden="true"/>:result?<span className={`semantic-mode ${result.mode}`} title={result.model || copy.keywordModeTitle}>{result.mode==='hybrid'?copy.modeHybrid:copy.modeKeyword}</span>:null}</div>
    {error && <p className="semantic-message" role="alert">{error}</p>}
    {warning && <p className="semantic-message">{warning}</p>}
    {!loading && result?.mode==='keyword' && !compact && <p className="semantic-help">{copy.keywordHelp}</p>}
    {loading && <p className="semantic-message" role="status">{copy.loadingMessage}</p>}
    {!loading && result?.results.length===0 && <p className="semantic-message">{copy.emptyMessage}</p>}
    <div className="semantic-results">{result?.results.map(item=> {
      const canOpen=item.kind==='lesson' || Boolean(onRepository);
      return <article className="semantic-result" key={item.id}>
        <div className="semantic-result-title">{item.kind==='lesson'?<BookOpen size={14} aria-hidden="true"/>:<FileCode2 size={14} aria-hidden="true"/>}{canOpen?<button type="button" onClick={()=>item.kind==='lesson'?onOpen(item.ownerId,item.sectionId):onRepository?.(item.ownerId)}><strong>{item.kind==='lesson'?lessonTitle(item.title):item.title}</strong><ArrowUpRight size={13} aria-hidden="true"/></button>:<strong>{item.kind==='lesson'?lessonTitle(item.title):item.title}</strong>}</div>
        <p>{item.text.length>(compact?165:310)?`${item.text.slice(0,compact?165:310)}…`:item.text}</p>
        <div className="semantic-citation"><span>{item.kind==='repo'?item.citation:copy.lessonCitationLabel}</span>{item.semanticScore!==undefined && <span title={copy.similarityTitle}>{formatSimilarityBadge(item.semanticScore)}</span>}</div>
      </article>;
    })}</div>
  </section>;
}
