import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelProtocol, applyModelSupplier, modelProtocols, modelProtocolOptions, supplierProtocolOptions } from '../src/api/modelProtocols.ts';
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
  assert.equal(next.reasoningEffort, null);
  assert.equal(next.capabilities.reasoningEffort, false);
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
  assert.equal(modelProtocols.anthropicMessages.reasoning, false);
  assert.equal(modelProtocolOptions.length, 3);
  assert.equal(applyModelProtocol(next, 'openAiCompatible').completionsPath, 'chat/completions');
  assert.equal(applyModelProtocol(config, 'openAiResponses').completionsPath, 'responses');
  assert.equal(modelProtocols.openAiResponses.fixedOutput, 'max_output_tokens');
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
