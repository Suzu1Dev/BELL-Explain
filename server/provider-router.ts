import { Router } from 'express';
import type { ProviderCatalog, ProviderInfo, ProviderSettings, ProviderSnapshot, ProviderStatus } from '../shared/settings.js';
import { createChat, type AIConfig, type ChatCall, type ChatUsage } from './ai.js';
import { logEvent } from './log.js';
import { AppError } from './errors.js';
import { createCodexChat, discoverCodex, codexRpcFactory, type CodexRpcFactory } from './codex.js';
import { createClaudeChat, discoverClaude, claudeCli, type ClaudeCli } from './claude.js';
import { antigravityCli, createAntigravityChat, discoverAntigravity, normalizeAntigravitySettings, type AntigravityCli } from './antigravity.js';
import { defaultPonytailMode } from '../shared/efficiency.js';
import { withPonytail } from './efficiency.js';
import { ProviderSettingsStore, providerSettingsPatchSchema, providerSettingsSchema } from './provider-settings.js';

export interface ProviderServiceOptions {
  store:ProviderSettingsStore;
  apiConfig?:AIConfig;
  codexPath?:string;
  rpcFactory?:CodexRpcFactory;
  discover?:typeof discoverCodex;
  claudePath?:string;
  claudeCli?:ClaudeCli;
  discoverClaude?:typeof discoverClaude;
  antigravityPath?:string;
  antigravityCli?:AntigravityCli;
  discoverAntigravity?:typeof discoverAntigravity;
}
export class ProviderService {
  private readonly factory:CodexRpcFactory;
  private readonly claude:ClaudeCli;
  private readonly antigravity:AntigravityCli;
  private cache?:ProviderCatalog;
  private loading?:Promise<ProviderCatalog>;
  constructor(private readonly options:ProviderServiceOptions){
    this.factory=options.rpcFactory || codexRpcFactory(options.codexPath);
    this.claude=options.claudeCli || claudeCli(options.claudePath);
    this.antigravity=options.antigravityCli || antigravityCli(options.antigravityPath);
  }
  private apiInfo():ProviderInfo{
    const config=this.options.apiConfig;
    const available=!!(config?.apiKey && config.model);
    return {id:'api',name:'相容 OpenAI API',available,authenticated:available,message:available?'使用伺服器 .env 的 API 設定。API 模式保留供應商預設推理與速度。':'請在 .env 設定 AI_API_KEY 與 AI_MODEL，重新啟動服務。',models:config?.model?[{
      id:config.model,name:config.model,description:'伺服器設定的 Chat Completions 模型',isDefault:true,
      defaultEffort:'default',efforts:[{id:'default',description:'供應商預設'}],
      speeds:[{id:'default',available:true,description:'供應商預設'},{id:'fast',available:false,description:'此 API 尚未提供速度能力資訊，請使用 Codex 模式。'},{id:'ultrafast',available:false,description:'此 API 尚未提供速度能力資訊，請使用 Codex 模式。'}],
    }]:[]};
  }
  async catalog(force=false):Promise<ProviderCatalog>{
    if(!force && this.cache && Date.now()-Date.parse(this.cache.checkedAt)<60_000)return structuredClone(this.cache);
    if(this.loading)return structuredClone(await this.loading);
    this.loading=(async()=>{
      const [codex,claude,antigravity]=await Promise.all([
        (this.options.discover||discoverCodex)(this.factory,AbortSignal.timeout(25_000))
          .catch((error):ProviderInfo=>({id:'codex',name:'Codex',available:false,authenticated:false,models:[],message:error instanceof AppError?error.message:'無法取得 Codex 模型清單。請確認 codex login 成功，並重新整理。'})),
        (this.options.discoverClaude||discoverClaude)(this.claude,AbortSignal.timeout(25_000))
          .catch((error):ProviderInfo=>({id:'claude',name:'Claude Code',available:false,authenticated:false,models:[],message:error instanceof AppError?error.message:'無法取得 Claude Code 登入狀態。請確認 claude auth login 成功，並重新整理。'})),
        (this.options.discoverAntigravity||discoverAntigravity)(this.antigravity,AbortSignal.timeout(25_000))
          .catch((error):ProviderInfo=>({id:'antigravity',name:'Antigravity',available:false,authenticated:false,models:[],message:error instanceof AppError?error.message:'無法取得 Antigravity 模型清單。請在終端執行 agy 完成登入，並重新整理。'})),
      ]);
      const catalog={providers:[codex,claude,antigravity,this.apiInfo()],checkedAt:new Date().toISOString()};
      this.cache=catalog;return catalog;
    })();
    try{return structuredClone(await this.loading);}finally{this.loading=undefined;}
  }
  async settings():Promise<ProviderSettings>{
    let settings=this.options.store.get();
    if(!settings.model || settings.provider==='antigravity'){
      const catalog=await this.catalog();
      const models=catalog.providers.find(item=>item.id===settings.provider)?.models||[];
      settings=normalizeAntigravitySettings(settings,models);
      if(!settings.model)settings.model=(models.find(model=>model.isDefault)||models[0])?.id||'';
    }
    return settings;
  }
  async snapshot(force=false):Promise<ProviderSnapshot>{
    const catalog=await this.catalog(force);
    return {settings:await this.settings(),catalog};
  }
  private validate(settings:ProviderSettings,catalog:ProviderCatalog){
    const provider=catalog.providers.find(item=>item.id===settings.provider);
    if(!provider?.available)throw new AppError(503,provider?.message||'模型供應商尚未連接。');
    const model=provider.models.find(item=>item.id===settings.model);
    if(!model)throw new AppError(400,'這個模型不在目前供應商可用清單，請重新整理模型。');
    if(settings.effort!=='default' && !model.efforts.some(option=>option.id===settings.effort))throw new AppError(400,'這個模型不支援所選 effort。');
    const speed=model.speeds.find(option=>option.id===settings.speed);
    if(!speed?.available)throw new AppError(400,speed?.description||'這個模型尚未提供所選速度。');
    return model;
  }
  async update(patch:unknown):Promise<ProviderSnapshot>{
    const parsed=providerSettingsPatchSchema.safeParse(patch);
    if(!parsed.success || !Object.keys(parsed.data).length)throw new AppError(400,'模型設定格式不正確。');
    const current=await this.settings();
    const catalog=await this.catalog();
    const providerModels=catalog.providers.find(item=>item.id===(parsed.data.provider??current.provider))?.models||[];
    const merged=normalizeAntigravitySettings({...current,...parsed.data},providerModels);
    this.validate(merged,catalog);
    this.options.store.save(merged);
    return {settings:merged,catalog};
  }
  async status():Promise<ProviderStatus>{
    const settings=await this.settings();
    const catalog=await this.catalog();
    try{this.validate(settings,catalog);return {...settings,configured:true,message:catalog.providers.find(item=>item.id===settings.provider)!.message};}
    catch(error){return {...settings,configured:false,message:error instanceof AppError?error.message:'模型設定無法使用。'};}
  }
  async createChat(signal?:AbortSignal,override?:Partial<ProviderSettings>):Promise<ChatCall>{
    signal?.throwIfAborted();
    const parsed=providerSettingsSchema.safeParse({...await this.settings(),...override});
    if(!parsed.success)throw new AppError(400,'模型設定格式不正確。');
    const catalog=await this.catalog();
    const providerModels=catalog.providers.find(item=>item.id===parsed.data.provider)?.models||[];
    const settings=normalizeAntigravitySettings(parsed.data,providerModels);
    const model=this.validate(settings,catalog);
    signal?.throwIfAborted();
    const ponytailMode=settings.ponytailMode ?? defaultPonytailMode;
    const rawChat=settings.provider==='codex'?createCodexChat(settings,model,this.factory)
      :settings.provider==='claude'?createClaudeChat(settings,model,this.claude)
      :settings.provider==='antigravity'?createAntigravityChat(settings,model,this.antigravity)
      :createChat({...this.options.apiConfig!,model:settings.model});
    const chat=withPonytail(rawChat,ponytailMode);
    return loggedChat(chat,{provider:settings.provider,model:settings.model,effort:settings.effort==='default'?model.defaultEffort:settings.effort,ponytailMode});
  }
}
/** One `gen.call` line per model call: who ran, how long, the outcome and reported tokens. */
export function loggedChat(chat:ChatCall,meta:{provider:string;model:string;effort:string;ponytailMode?:string}):ChatCall{
  return async(role,instruction,data,signal,onProgress,images)=>{
    const started=Date.now();
    let usage:ChatUsage|undefined;
    const done=(outcome:string)=>logEvent('gen.call',{...meta,role,ms:Date.now()-started,outcome,images:images?.length||0,...(usage?{usage}:{})});
    try{
      const result=await chat(role,instruction,data,signal,progress=>{if(progress.usage)usage=progress.usage;onProgress?.(progress);},images);
      done('ok');
      return result;
    }catch(error){
      done(error instanceof AppError?`error:${error.status}`:error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)?error.name:'error');
      throw error;
    }
  };
}
export function createProviderRouter(service:ProviderService):Router{
  const router=Router();
  router.get('/settings',async(req,res)=>res.json(await service.snapshot(req.query.refresh==='true')));
  router.patch('/settings',async(req,res)=>res.json(await service.update(req.body)));
  router.get('/models',async(req,res)=>res.json(await service.catalog(req.query.refresh==='true')));
  return router;
}
