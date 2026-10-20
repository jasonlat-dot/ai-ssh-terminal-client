import { builtinRequest } from './builtin';
import { sshUserId } from './ssh';

export type ModelConfig = {
  provider: 'openAiCompatible'|'openAiResponses'|'anthropicMessages'|'googleGemini'; remoteCompaction?: boolean; baseUrl: string; completionsPath: string; model: string;
  contextWindow: number; outputReserve: number; safetyReserve: number; compactPercent: number;
  outputTokenParameter: 'maxCompletionTokens' | 'maxTokens';
  capabilities: { toolCalls: boolean; developerRole: boolean; temperature: boolean; reasoningEffort: boolean; vision: boolean };
  temperature: number | null; reasoningEffort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|null;
  timeoutSeconds: number; maxResponseBytes: number; requireApiKey: boolean;
};
export type ModelProfile = { id: string; displayName?: string; revision: number; config: ModelConfig; apiKeyConfigured: boolean; ready: boolean };
export type ModelChannel = ModelProfile & { models: {id:string;model:string}[] };
export type KeyChange = { action: 'keep'|'clear' } | { action: 'set'; value: string };
export const newModelConfig = (): ModelConfig => ({
  provider: 'openAiCompatible', remoteCompaction: false, baseUrl: '', completionsPath: 'chat/completions', model: '',
  contextWindow: 256000, outputReserve: 2048, safetyReserve: 8192, compactPercent: 75,
  outputTokenParameter: 'maxCompletionTokens',
  capabilities: { toolCalls: true, developerRole: false, temperature: false, reasoningEffort: false, vision: true },
  temperature: null, reasoningEffort: null, timeoutSeconds: 120, maxResponseBytes: 1048576, requireApiKey: true,
});
export type CatalogModel = {id: string; displayName?: string};
export type CatalogQuery = {provider: ModelConfig['provider']; baseUrl: string; requireApiKey: boolean;
  apiKey: KeyChange; channelId: string | null; revision: number | null};
export const modelApi = {
  discover: (query: CatalogQuery, signal?: AbortSignal) =>
    builtinRequest<CatalogModel[]>('agent/model_catalog', 'POST', {userId:sshUserId, query}, {}, signal),
  channels: () => builtinRequest<ModelChannel[]>('agent/model_channels', 'GET', undefined, {userId:sshUserId}),
  saveChannel: (id:string, revision:number, config:ModelConfig, apiKey:KeyChange, displayName:string, modelIds:string[]) =>
    builtinRequest<ModelChannel>('agent/model_channels','POST',{id,revision,userId:sshUserId,displayName,modelIds,update:{config,apiKey}},{}),
  deleteChannel: (id:string,revision:number) => builtinRequest<boolean>('agent/model_channels','DELETE',{id,revision,userId:sshUserId},{}),
  list: () => builtinRequest<ModelProfile[]>('agent/models', 'GET', undefined, { userId: sshUserId }),
  save: (id: string, revision: number, config: ModelConfig, apiKey: KeyChange, displayName?: string) =>
    builtinRequest<ModelProfile>('agent/models', 'POST', { id, revision, userId: sshUserId, update: { config, apiKey }, ...(displayName === undefined ? {} : { displayName }) }, {}),
  delete: (id: string, revision: number) =>
    builtinRequest<boolean>('agent/models', 'DELETE', { id, revision, userId: sshUserId }, {}),
};
