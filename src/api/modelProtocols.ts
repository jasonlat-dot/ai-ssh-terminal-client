import type { ModelConfig } from './models';

export type ModelSupplier = 'openai' | 'anthropic';

type ProtocolDescriptor = {
  supplier: ModelSupplier; name: string;
  label: string; description: string; path: string; fixedOutput: string | null;
  temperatureMax: number; reasoning: boolean;
};
/** One exhaustive catalog drives protocol-dependent controls and defaults. */
export const modelProtocols: Record<ModelConfig['provider'], ProtocolDescriptor> = {
  openAiCompatible: { supplier: 'openai', name: 'Chat Completions', label: 'Chat Completions · OpenAI 兼容', description: '使用 OpenAI 兼容 Chat Completions；自动回传推理字段与 Gemini 工具签名。', path: 'chat/completions', fixedOutput: null, temperatureMax: 2, reasoning: true },
  openAiResponses: { supplier: 'openai', name: 'Responses', label: 'Responses · OpenAI 兼容', description: '支持文字、工具调用与推理续接；供应商须支持 Responses 与输入 token 计数。', path: 'responses', fixedOutput: 'max_output_tokens', temperatureMax: 2, reasoning: true },
  anthropicMessages: { supplier: 'anthropic', name: 'Messages', label: 'Messages · Claude / Anthropic', description: '使用 Anthropic Messages，支持文字、图片、工具调用及思考签名续接；思考模式沿用供应商默认。', path: 'messages', fixedOutput: 'max_tokens', temperatureMax: 1, reasoning: false },
};
export const modelProtocolOptions = Object.entries(modelProtocols).map(([value, protocol]) => ({value: value as ModelConfig['provider'], label: protocol.label}));
export function applyModelProtocol(config: ModelConfig, provider: ModelConfig['provider']): ModelConfig {
  const protocol = modelProtocols[provider];
  const temperature = config.temperature !== null && config.temperature > protocol.temperatureMax ? null : config.temperature;
  return { ...config, provider, completionsPath: protocol.path, remoteCompaction: false,
    outputTokenParameter: protocol.fixedOutput === 'max_tokens' ? 'maxTokens' : config.outputTokenParameter,
    temperature, reasoningEffort: protocol.reasoning ? config.reasoningEffort : null,
    capabilities: {...config.capabilities, temperature: temperature !== null,
      reasoningEffort: protocol.reasoning && config.capabilities.reasoningEffort},
  };
}


/** Supplier choices are UI metadata; persisted provider IDs remain wire protocol IDs. */
export const modelSuppliers: Record<ModelSupplier, {label: string; defaultProtocol: ModelConfig['provider']; basePlaceholder: string}> = {
  openai: {label: 'OpenAI 兼容', defaultProtocol: 'openAiCompatible', basePlaceholder: 'https://api.openai.com/v1/'},
  anthropic: {label: 'Anthropic 兼容', defaultProtocol: 'anthropicMessages', basePlaceholder: 'https://api.anthropic.com/v1/'},
};
export const modelSupplierOptions = Object.entries(modelSuppliers).map(([value, supplier]) => ({value: value as ModelSupplier, label: supplier.label}));
export function supplierProtocolOptions(supplier: ModelSupplier) {
  return modelProtocolOptions.filter(option => modelProtocols[option.value].supplier === supplier)
    .map(option => ({...option, label: modelProtocols[option.value].name}));
}
export function applyModelSupplier(config: ModelConfig, supplier: ModelSupplier): ModelConfig {
  if (modelProtocols[config.provider].supplier === supplier) return config;
  return applyModelProtocol(config, modelSuppliers[supplier].defaultProtocol);
}
