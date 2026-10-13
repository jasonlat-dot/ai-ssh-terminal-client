import { builtinRequest } from './builtin';
import { sshUserId } from './ssh';

export type ModelConfig = {
  provider: 'openAiCompatible'; baseUrl: string; completionsPath: string; model: string;
  contextWindow: number; outputReserve: number; safetyReserve: number; compactPercent: number;
  outputTokenParameter: 'maxCompletionTokens' | 'maxTokens';
  capabilities: { toolCalls: boolean; developerRole: boolean; temperature: boolean; reasoningEffort: boolean; vision: boolean };
  temperature: number | null; reasoningEffort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|null;
  timeoutSeconds: number; maxResponseBytes: number; requireApiKey: boolean;
};
export type ModelProfile = { id: string; displayName?: string; revision: number; config: ModelConfig; apiKeyConfigured: boolean; ready: boolean };
export type KeyChange = { action: 'keep'|'clear' } | { action: 'set'; value: string };
export const newModelConfig = (): ModelConfig => ({
  provider: 'openAiCompatible', baseUrl: '', completionsPath: 'chat/completions', model: '',
  contextWindow: 8192, outputReserve: 1024, safetyReserve: 512, compactPercent: 75,
  outputTokenParameter: 'maxCompletionTokens',
  capabilities: { toolCalls: false, developerRole: false, temperature: false, reasoningEffort: false, vision: false },
  temperature: null, reasoningEffort: null, timeoutSeconds: 120, maxResponseBytes: 1048576, requireApiKey: true,
});
export const modelApi = {
  list: () => builtinRequest<ModelProfile[]>('agent/models', 'GET', undefined, { userId: sshUserId }),
  save: (id: string, revision: number, config: ModelConfig, apiKey: KeyChange, displayName?: string) =>
    builtinRequest<ModelProfile>('agent/models', 'POST', { id, revision, userId: sshUserId, update: { config, apiKey }, ...(displayName === undefined ? {} : { displayName }) }, {}),
  delete: (id: string, revision: number) =>
    builtinRequest<boolean>('agent/models', 'DELETE', { id, revision, userId: sshUserId }, {}),
};
