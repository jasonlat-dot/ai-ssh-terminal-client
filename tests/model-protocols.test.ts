import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelProtocol, applyModelSupplier, modelProtocols, modelProtocolOptions, supplierProtocolOptions, modelSupplier, modelProtocolInfo, modelBasePlaceholder, resolvedModelBaseUrl, modelSupplierOptions } from '../src/api/modelProtocols.ts';
import { newModelConfig } from '../src/api/models.ts';

test('Claude 协议切换使用原生路径、输出参数及能力，保留代理地址且不修改原对象', () => {
  const original = newModelConfig();
  original.baseUrl = 'https://proxy.example/anthropic/v1/';
  original.remoteCompaction = true;
  original.temperature = 1.5;
  original.reasoningEffort = 'high';
  original.capabilities.reasoningEffort = true;
  const next = applyModelProtocol(original, 'anthropicMessages');
  assert.equal(next.baseUrl, original.baseUrl);
  assert.equal(next.completionsPath, 'messages');
  assert.equal(next.outputTokenParameter, 'maxTokens');
  assert.equal(next.remoteCompaction, false);
  assert.equal(next.temperature, null);
  assert.equal(next.capabilities.temperature, false);
  assert.equal(next.reasoningEffort, 'high');
  assert.equal(next.capabilities.reasoningEffort, true);
  assert.equal(next.capabilities.toolCalls, true);
  assert.equal(next.capabilities.vision, true);
  assert.equal(original.provider, 'openAiCompatible');
  assert.equal(original.reasoningEffort, 'high');
});
test('空地址切换 Claude 后保持留空，合法温度保留，目录覆盖所有协议', () => {
  const config = newModelConfig();config.temperature = 0.7;
  const next = applyModelProtocol(config, 'anthropicMessages');
  assert.equal(next.baseUrl, '');
  assert.equal(next.temperature, 0.7);
  assert.equal(modelProtocols.anthropicMessages.temperatureMax, 1);
  assert.equal(modelProtocols.anthropicMessages.reasoning, true);
  assert.equal(modelProtocolOptions.length, 4);
  assert.equal(applyModelProtocol(next, 'openAiCompatible').completionsPath, 'chat/completions');
  assert.equal(applyModelProtocol(config, 'openAiResponses').completionsPath, 'responses');
  assert.equal(modelProtocols.openAiResponses.fixedOutput, 'max_output_tokens');
});

test('协议目录提供不同原生强度选项，切换协议清除不适用的档位', () => {
  assert.deepEqual(modelProtocols.anthropicMessages.effortOptions.map(option => option.value), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelProtocols.openAiCompatible.effortOptions.map(option => option.value), ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  for (const effort of ['none', 'minimal'] as const) {
    const next = applyModelProtocol({...newModelConfig(), reasoningEffort: effort}, 'anthropicMessages');
    assert.equal(next.reasoningEffort, null);
    assert.equal(next.capabilities.reasoningEffort, false);
  }
  for (const protocol of ['openAiCompatible', 'openAiResponses'] as const) {
    const next = applyModelProtocol({...newModelConfig(), provider: 'anthropicMessages', reasoningEffort: 'max'}, protocol);
    assert.equal(next.reasoningEffort, null);
    assert.equal(next.capabilities.reasoningEffort, false);
  }
});


test('供应商目录分离 OpenAI 两种协议与 Anthropic 原生协议', () => {
  assert.deepEqual(supplierProtocolOptions('openai').map(item => item.value), ['openAiCompatible','openAiResponses']);
  assert.deepEqual(supplierProtocolOptions('anthropic').map(item => item.value), ['anthropicMessages']);
  const blank = applyModelSupplier(newModelConfig(), 'anthropic');
  assert.equal(blank.baseUrl, '');
  assert.equal(applyModelSupplier(blank, 'openai').baseUrl, '');
  let config = newModelConfig();config.baseUrl = 'https://api.openai.com/v1/';
  config = applyModelSupplier(config, 'anthropic');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1/');
  assert.equal(config.completionsPath, 'messages');
  config = applyModelSupplier(config, 'openai');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1/');assert.equal(config.provider, 'openAiCompatible');
  const proxy = {...config, baseUrl:'https://custom.proxy/v1/'};
  assert.equal(applyModelSupplier(proxy, 'anthropic').baseUrl,proxy.baseUrl);
  const responses = {...config, provider:'openAiResponses' as const};
  assert.equal(applyModelSupplier(responses, 'openai'),responses);
});


test('Google 使用独立原生协议和参数目录，切换保留地址并清除不支持的强度', () => {
  assert.deepEqual(supplierProtocolOptions('google').map(option=>option.value), ['googleGemini']);
  const original={...newModelConfig(),baseUrl:'https://proxy.test/gemini/v1beta/',remoteCompaction:true,reasoningEffort:'max' as const};
  const config=applyModelSupplier(original,'google');
  assert.equal(config.provider,'googleGemini');assert.equal(config.completionsPath,'models');
  assert.equal(config.baseUrl,original.baseUrl);assert.equal(config.outputTokenParameter,'maxTokens');
  assert.equal(config.remoteCompaction,false);assert.equal(config.reasoningEffort,null);
  assert.deepEqual(modelProtocols.googleGemini.effortOptions.map(o=>o.value),['','minimal','low','medium','high']);
  assert.equal(modelProtocols.googleGemini.fixedOutput,'maxOutputTokens');
  assert.equal(applyModelSupplier(newModelConfig(),'google').baseUrl,'');
});


test('DeepSeek 身份独立保存，复用 Chat 与 Messages，切换保持自定义地址且不修改旧对象', () => {
  const old=newModelConfig();const config=applyModelSupplier(old,'deepseek');
  assert.equal(modelSupplier(old),'openai');assert.equal(modelSupplier(config),'deepseek');assert.equal(config.baseUrl,'');
  assert.equal(config.provider,'openAiCompatible');assert.equal(config.outputTokenParameter,'maxTokens');
  assert.equal(modelBasePlaceholder(config),'https://api.deepseek.com/v1');
  assert.deepEqual(supplierProtocolOptions('deepseek').map(item=>item.value),['openAiCompatible','anthropicMessages']);
  const messages=applyModelProtocol({...config,baseUrl:'https://proxy.test/custom/'},'anthropicMessages');
  assert.equal(messages.supplier,'deepseek');assert.equal(messages.completionsPath,'messages');assert.equal(messages.baseUrl,'https://proxy.test/custom/');
  assert.equal(modelBasePlaceholder(messages),'https://api.deepseek.com/anthropic/v1');
  assert.equal(modelSupplier(applyModelSupplier(messages,'anthropic')),'anthropic');
  assert.equal(applyModelSupplier(messages,'anthropic').supplier,undefined);
});

test('DeepSeek 参数目录支持其思考档位和 max_tokens，切回通用协议清理特有档位', () => {
  const config=applyModelSupplier(newModelConfig(),'deepseek');
  assert.deepEqual(modelProtocolInfo(config).effortOptions.map(item=>item.value),['','none','low','high','max']);
  assert.equal(modelProtocolInfo(config).supplier,'deepseek');assert.equal(modelProtocolInfo(config).fixedOutput,'max_tokens');assert.equal(modelProtocolInfo({...config,provider:'anthropicMessages'}).temperatureMax,2);
  const next=applyModelSupplier({...config,reasoningEffort:'max'},'openai');assert.equal(next.reasoningEffort,null);
  assert.equal(modelProtocols.anthropicMessages.temperatureMax,1);assert.equal(modelProtocols.openAiCompatible.fixedOutput,null);
});


test('各供应商留空地址使用同一提示默认值，Google 默认 v1beta 且不回填草稿或改写中转', () => {
  for (const {value:supplier} of modelSupplierOptions) {
    for (const {value:provider} of supplierProtocolOptions(supplier)) {
      const config=applyModelProtocol(applyModelSupplier(newModelConfig(),supplier),provider);
      const expected=modelBasePlaceholder(config);assert.match(expected,supplier==='google'?/\/v1beta$/:supplier==='glm'&&provider==='openAiCompatible'?/\/paas\/v4$/:/\/v1$/);
      if(supplier==='google')assert.equal(expected,'https://generativelanguage.googleapis.com/v1beta');
      assert.equal(resolvedModelBaseUrl(config),expected);assert.equal(config.baseUrl,'');
      assert.equal(resolvedModelBaseUrl({...config,baseUrl:'   '}),expected);
      assert.equal(resolvedModelBaseUrl({...config,baseUrl:'https://generativelanguage.googleapis.com/v1'}),'https://generativelanguage.googleapis.com/v1');
      assert.equal(resolvedModelBaseUrl({...config,baseUrl:'  https://proxy.test/custom/v1beta/  '}),'https://proxy.test/custom/v1beta/');
    }
  }
});

test('GLM 独立身份复用双协议，采用智谱地址、温度范围与推理目录，保留代理和模型 ID', () => {
  const original={...newModelConfig(),model:'custom-alias',temperature:1.7,reasoningEffort:'medium' as const,baseUrl:'https://proxy.test/custom/'};
  const config=applyModelSupplier(original,'glm');
  assert.equal(config.supplier,'glm');assert.equal(config.model,'custom-alias');assert.equal(config.baseUrl,original.baseUrl);
  assert.equal(config.temperature,null);assert.equal(config.reasoningEffort,null);assert.equal(config.outputTokenParameter,'maxTokens');
  assert.deepEqual(supplierProtocolOptions('glm').map(option=>option.value),['openAiCompatible','anthropicMessages']);
  for(const provider of ['openAiCompatible','anthropicMessages'] as const) {
    const next=applyModelProtocol({...config,temperature:0.7,reasoningEffort:'max'},provider);
    assert.equal(modelSupplier(next),'glm');assert.equal(next.temperature,0.7);assert.equal(next.reasoningEffort,'max');
    assert.equal(modelBasePlaceholder(next),provider==='openAiCompatible'?'https://open.bigmodel.cn/api/paas/v4':'https://open.bigmodel.cn/api/anthropic/v1');
    assert.deepEqual(modelProtocolInfo(next).effortOptions.map(option=>option.value),['','none','low','high','max']);
    assert.equal(modelProtocolInfo(next).temperatureMax,1);assert.match(modelProtocolInfo(next).effortHint,/不能关闭/);
  }
  assert.equal(applyModelProtocol(config,'openAiResponses').supplier,undefined);
  assert.equal(applyModelSupplier(config,'openai').supplier,undefined);
  assert.equal(applyModelSupplier(config,'deepseek').supplier,'deepseek');
  assert.equal(original.temperature,1.7);assert.equal(original.reasoningEffort,'medium');
});
