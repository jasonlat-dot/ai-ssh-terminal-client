import type { ModelConfig, ModelSupplier } from './models';
export type { ModelSupplier } from './models';

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
const googleEfforts: EffortOption[] = [defaultEffort, ...openAiEfforts.filter(option => ['minimal', 'low', 'medium', 'high'].includes(option.value))];
const claudeEfforts: EffortOption[] = [defaultEffort, ...sharedEfforts,
  { value: 'max', label: '最高', description: 'max，需模型支持' }];

type ProtocolDescriptor = {
  supplier: ModelSupplier; name: string;
  label: string; description: string; path: string; fixedOutput: string | null;
  temperatureMax: number; temperatureStep?: number; reasoning: boolean; effortOptions: EffortOption[]; effortHint: string; pathHint?: string;
};
/** One exhaustive catalog drives protocol-dependent controls and defaults. */
export const modelProtocols: Record<ModelConfig['provider'], ProtocolDescriptor> = {
  openAiCompatible: { supplier: 'openai', name: 'Chat Completions', label: 'Chat Completions · OpenAI 兼容', description: '使用 OpenAI 兼容 Chat Completions；自动回传推理字段与 Gemini 工具签名。', path: 'chat/completions', fixedOutput: null, temperatureMax: 2, reasoning: true, effortOptions: openAiEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。' },
  openAiResponses: { supplier: 'openai', name: 'Responses', label: 'Responses · OpenAI 兼容', description: '支持文字、工具调用与推理续接；供应商须支持 Responses 与输入 token 计数。', path: 'responses', fixedOutput: 'max_output_tokens', temperatureMax: 2, reasoning: true, effortOptions: openAiEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。' },
  googleGemini: { supplier: 'google', name: 'GenerateContent', label: 'GenerateContent · Google Gemini', description: '使用 Google Gemini 原生接口，支持文字、图片、工具调用与签名续接。', path: 'models', pathHint: '模型 ID 与生成方法会自动附加到此路径；基础地址应包含 API 版本。', fixedOutput: 'maxOutputTokens', temperatureMax: 2, reasoning: true, effortOptions: googleEfforts, effortHint: '默认不发送；thinkingLevel 用于 Gemini 3 及后续支持的模型，较早模型请保持默认。' },
  anthropicMessages: { supplier: 'anthropic', name: 'Messages', label: 'Messages · Claude / Anthropic', description: '使用 Anthropic Messages，支持文字、图片、工具调用、原生思考强度及签名续接。', path: 'messages', fixedOutput: 'max_tokens', temperatureMax: 1, reasoning: true, effortOptions: claudeEfforts, effortHint: '默认不发送；仅选择模型和接口支持的档位。强度影响思考、回复和工具调用；最大输出需为思考及正文留足空间。' },
};
export const modelProtocolOptions = Object.entries(modelProtocols).map(([value, protocol]) => ({value: value as ModelConfig['provider'], label: protocol.label}));
export function applyModelProtocol(config: ModelConfig, provider: ModelConfig['provider']): ModelConfig {
  const supplier = config.supplier && !modelSuppliers[config.supplier].protocols.includes(provider) ? undefined : config.supplier;
  const protocol = modelProtocolInfo({...config, provider, supplier});
  const temperature = config.temperature !== null && config.temperature > protocol.temperatureMax ? null : config.temperature;
  const reasoningEffort = protocol.effortOptions.some(option => option.value === config.reasoningEffort) ? config.reasoningEffort : null;
  return { ...config, provider, supplier, completionsPath: protocol.path, remoteCompaction: false,
    outputTokenParameter: protocol.fixedOutput !== null && protocol.fixedOutput !== 'max_output_tokens' ? 'maxTokens' : config.outputTokenParameter,
    temperature, reasoningEffort,
    capabilities: {...config.capabilities, temperature: temperature !== null,
      reasoningEffort: reasoningEffort !== null},
  };
}


/** Supplier identity persists independently from its reusable wire protocol. Legacy configs infer it from provider. */
type SupplierDescriptor = {label: string; defaultProtocol: ModelConfig['provider']; protocols: ModelConfig['provider'][]; basePlaceholder: string;
  protocolBases?: Partial<Record<ModelConfig['provider'], string>>; overrides?: Partial<ProtocolDescriptor>};
const thinkingEfforts: EffortOption[] = [defaultEffort, {value: 'none', label: '关闭', description: '关闭思考'},
  ...sharedEfforts.filter(option => option.value === 'low' || option.value === 'high'), {value: 'max', label: '最高', description: 'max，需模型支持'}];
export const modelSuppliers: Record<ModelSupplier, SupplierDescriptor> = {
  openai: {label: 'OpenAI 兼容', defaultProtocol: 'openAiCompatible', protocols: ['openAiCompatible', 'openAiResponses'], basePlaceholder: 'https://api.openai.com/v1'},
  anthropic: {label: 'Anthropic 兼容', defaultProtocol: 'anthropicMessages', protocols: ['anthropicMessages'], basePlaceholder: 'https://api.anthropic.com/v1'},
  google: {label: 'Google 兼容', defaultProtocol: 'googleGemini', protocols: ['googleGemini'], basePlaceholder: 'https://generativelanguage.googleapis.com/v1beta'},
  deepseek: {label: 'DeepSeek', defaultProtocol: 'openAiCompatible', protocols: ['openAiCompatible', 'anthropicMessages'], basePlaceholder: 'https://api.deepseek.com/v1',
    protocolBases: {anthropicMessages: 'https://api.deepseek.com/anthropic/v1'},
    overrides: {fixedOutput: 'max_tokens', temperatureMax: 2, description: '使用 DeepSeek 接口，支持对话、工具调用和思考续接。',
      effortOptions: thinkingEfforts, effortHint: '默认使用上游设置；关闭思考或选择模型支持的强度。思考模式下 Temperature 不生效。'}},
  glm: {label: 'GLM / 智谱', defaultProtocol: 'openAiCompatible', protocols: ['openAiCompatible', 'anthropicMessages'], basePlaceholder: 'https://open.bigmodel.cn/api/paas/v4',
    protocolBases: {anthropicMessages: 'https://open.bigmodel.cn/api/anthropic/v1'},
    overrides: {fixedOutput: 'max_tokens', temperatureMax: 1, description: '使用 GLM / 智谱接口，支持对话、工具调用和思考续接。',
      effortOptions: thinkingEfforts.map(option => option.value === 'none' ? {...option, description: '需模型支持'} : option),
      effortHint: '默认使用上游设置；强度需模型支持，部分模型强制思考，不能关闭。较早模型请保持默认。'}},
  qwen: {label: 'Qwen / 通义千问', defaultProtocol: 'openAiCompatible', protocols: ['openAiCompatible', 'anthropicMessages'], basePlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocolBases: {anthropicMessages: 'https://dashscope.aliyuncs.com/apps/anthropic/v1'},
    overrides: {fixedOutput: 'max_tokens', temperatureMax: 1.99, temperatureStep: 0.01, description: '使用百炼 Qwen 接口，支持对话、工具调用和思考续接。',
      effortOptions: [defaultEffort, {value: 'none', label: '关闭', description: '需模型支持'}, {value: 'enabled', label: '开启', description: '不指定强度'},
        ...sharedEfforts.filter(option => ['low', 'medium', 'xhigh'].includes(option.value))],
      effortHint: '默认使用上游设置；开启仅启用思考，不指定强度。低、中、很高需模型支持；不支持思考的模型请保持默认。'}},
};
export function modelSupplier(config: {supplier?: ModelSupplier; provider: ModelConfig['provider']}): ModelSupplier {
  return config.supplier ?? modelProtocols[config.provider].supplier;
}
export function modelProtocolInfo(config: {supplier?: ModelSupplier; provider: ModelConfig['provider']}): ProtocolDescriptor {
  const supplier = modelSupplier(config);
  return {...modelProtocols[config.provider], ...modelSuppliers[supplier].overrides, supplier};
}
export function modelBasePlaceholder(config: {supplier?: ModelSupplier; provider: ModelConfig['provider']}) {
  const supplier = modelSuppliers[modelSupplier(config)];
  return supplier.protocolBases?.[config.provider] ?? supplier.basePlaceholder;
}
/** Resolve only at the operation boundary so an empty draft stays visibly empty. */
export function resolvedModelBaseUrl(config: Pick<ModelConfig, 'supplier' | 'provider' | 'baseUrl'>): string {
  return config.baseUrl.trim() || modelBasePlaceholder(config);
}
export const modelSupplierOptions = Object.entries(modelSuppliers).map(([value, supplier]) => ({value: value as ModelSupplier, label: supplier.label}));
export function supplierProtocolOptions(supplier: ModelSupplier) {
  return modelSuppliers[supplier].protocols.map(value => ({value, label: modelProtocols[value].name}));
}
export function applyModelSupplier(config: ModelConfig, supplier: ModelSupplier): ModelConfig {
  if (modelSupplier(config) === supplier) return config;
  const provider = modelSuppliers[supplier].defaultProtocol;
  return applyModelProtocol({...config, supplier: supplier === modelProtocols[provider].supplier ? undefined : supplier}, provider);
}
