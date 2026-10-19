import type { ModelConfig } from './models';

export type ModelSupplier = 'openai' | 'anthropic';

type EffortOption = { value: NonNullable<ModelConfig['reasoningEffort']> | ''; label: string; description: string };
const defaultEffort: EffortOption = { value: '', label: '默认', description: '供应商默认' };
const sharedEfforts: EffortOption[] = [
  { value: 'low', label: '低', description: 'low' },
  { value: 'medium', label: '中', description: 'medium' },
  { value: 'high', label: '高', description: 'high' },
  { value: 'xhigh', label: '很高', description: 'xhigh，需模型支持' },
];
const openAiEfforts: EffortOption[] = [defaultEffort,
  { value: 'none', label: '关闭', description: 'none，需模型支持' },
  { value: 'minimal', label: '极低', description: 'minimal，需模型支持' }, ...sharedEfforts];
const claudeEfforts: EffortOption[] = [defaultEffort, ...sharedEfforts,
  { value: 'max', label: '最高', description: 'max，需模型支持' }];

type ProtocolDescriptor = {
  supplier: ModelSupplier; name: string;
  label: string; description: string; path: string; fixedOutput: string | null;
  temperatureMax: number; reasoning: boolean; effortOptions: EffortOption[]; effortHint: string;
};
/** One exhaustive catalog drives protocol-dependent controls and defaults. */
export const modelProtocols: Record<ModelConfig['provider'], ProtocolDescriptor> = {
  openAiCompatible: { supplier: 'openai', name: 'Chat Completions', label: 'Chat Completions · OpenAI 兼容', description: '使用 OpenAI 兼容 Chat Completions；自动回传推理字段与 Gemini 工具签名。', path: 'chat/completions', fixedOutput: null, temperatureMax: 2, reasoning: true, effortOptions: openAiEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。' },
  openAiResponses: { supplier: 'openai', name: 'Responses', label: 'Responses · OpenAI 兼容', description: '支持文字、工具调用与推理续接；供应商须支持 Responses 与输入 token 计数。', path: 'responses', fixedOutput: 'max_output_tokens', temperatureMax: 2, reasoning: true, effortOptions: openAiEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。' },
  anthropicMessages: { supplier: 'anthropic', name: 'Messages', label: 'Messages · Claude / Anthropic', description: '使用 Anthropic Messages，支持文字、图片、工具调用、原生思考强度及签名续接。', path: 'messages', fixedOutput: 'max_tokens', temperatureMax: 1, reasoning: true, effortOptions: claudeEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。强度影响思考、回复和工具调用；最大输出需为思考及正文留足空间。' },
};
export const modelProtocolOptions = Object.entries(modelProtocols).map(([value, protocol]) => ({value: value as ModelConfig['provider'], label: protocol.label}));
export function applyModelProtocol(config: ModelConfig, provider: ModelConfig['provider']): ModelConfig {
  const protocol = modelProtocols[provider];
  const temperature = config.temperature !== null && config.temperature > protocol.temperatureMax ? null : config.temperature;
  const reasoningEffort = protocol.effortOptions.some(option => option.value === config.reasoningEffort) ? config.reasoningEffort : null;
  return { ...config, provider, completionsPath: protocol.path, remoteCompaction: false,
    outputTokenParameter: protocol.fixedOutput === 'max_tokens' ? 'maxTokens' : config.outputTokenParameter,
    temperature, reasoningEffort,
    capabilities: {...config.capabilities, temperature: temperature !== null,
      reasoningEffort: reasoningEffort !== null},
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
