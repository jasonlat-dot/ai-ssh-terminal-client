import assert from 'node:assert/strict';
import test from 'node:test';
import {delimiter, dirname, join} from 'node:path';
import {findRuntime, runtimeEnvironment, supportedVersion} from '../scripts/node-runtime.mjs';

test('开发工具接受 Vite 的版本边界，拒绝 Node 18、21 和过早的 20/22', () => {
  for (const version of ['v18.12.0', 'v20.18.9', 'v21.7.3', 'v22.11.9', 'garbage']) {
    assert.equal(supportedVersion(version), false, version);
  }
  for (const version of ['v20.19.0', 'v22.12.0', 'v24.19.0', '22.13.1']) {
    assert.equal(supportedVersion(version), true, version);
  }
});

test('旧 Node 启动时会越过 PATH 中的旧版本并使用已有兼容版本', () => {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const old = join('old-node', name), modern = join('modern-node', name);
  assert.equal(findRuntime({
    current: old, env: {Path: ['old-node', 'modern-node'].join(delimiter)}, home: 'unused',
    exists: file => file === old || file === modern,
    version: file => file === old ? 'v18.12.0' : 'v24.19.0',
  }), modern);
});

test('显式 Node 路径必须可用，不静默忽略用户配置', () => {
  assert.throws(() => findRuntime({
    env: {SHELLPILOT_NODE: 'missing'}, current: 'modern', home: 'unused',
    exists: file => file === 'modern', version: () => 'v24.19.0',
  }), /SHELLPILOT_NODE/);
  assert.equal(findRuntime({
    env: {SHELLPILOT_NODE: 'explicit'}, current: 'modern', home: 'unused',
    exists: () => true, version: () => 'v22.12.0',
  }), 'explicit');
});

test('兼容运行时进入子进程 PATH，原环境不变且保留 npm 身份', () => {
  const env = {Path: 'original', npm_execpath: 'npm-cli.js', OTHER: 'keep'};
  const executable = join('modern-node', 'node.exe');
  const child = runtimeEnvironment(executable, env);
  assert.equal(child.Path, [dirname(executable), 'original'].join(delimiter));
  assert.equal(child.npm_node_execpath, executable);
  assert.equal(child.npm_execpath, 'npm-cli.js');
  assert.equal(child.OTHER, 'keep');
  assert.equal(env.Path, 'original');
  assert.equal(Object.hasOwn(child, 'PATH'), false);
});

test('找不到兼容版本时提供明确修复方式，不调用开发工具', () => {
  assert.throws(() => findRuntime({
    current: 'old', env: {}, home: 'unused', exists: file => file === 'old',
    version: () => 'v18.12.0',
  }), /Node 20\.19\+.*Node 22\.12\+.*SHELLPILOT_NODE/);
});
