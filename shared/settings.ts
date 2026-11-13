export type AIProvider = 'codex' | 'claude' | 'antigravity' | 'api';
import type { PonytailMode } from './efficiency.js';
export type AISpeed = 'default' | 'fast' | 'ultrafast';
export interface ProviderSettings {
  provider: AIProvider;
  model: string;
  /** `default` follows the model's advertised default effort. */
  effort: string;
  speed: AISpeed;
  /** Efficiency mode built on Ponytail; defaults to "full". */
  ponytailMode?: PonytailMode;
}
export interface ModelEffortOption { id:string; description:string; }
export interface ModelSpeedOption {
  id:AISpeed;
  available:boolean;
  description:string;
  /** Exact service tier advertised by the provider; never inferred from speed alone. */
  serviceTier?:string;
}
export interface ProviderModel {
  id:string; name:string; description:string; isDefault:boolean;
  defaultEffort:string; efforts:ModelEffortOption[]; speeds:ModelSpeedOption[];
}
export interface ProviderInfo {
  id:AIProvider; name:string; available:boolean; authenticated:boolean;
  message:string; models:ProviderModel[];
}
export interface ProviderCatalog { providers:ProviderInfo[]; checkedAt:string; }
export interface ProviderSnapshot { settings:ProviderSettings; catalog:ProviderCatalog; }
export interface ProviderStatus { configured:boolean; model:string; provider:AIProvider; effort:string; speed:AISpeed; message:string; }
