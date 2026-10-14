import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChatTarget, resolveScopeDisplay, scopeTerminal } from '../src/state/chatTarget.ts';
import { chatErrorGuidance } from '../src/api/chatErrors.ts';
import type { Host, TerminalSession } from '../src/types.ts';

const host = { id: 'a', name: '服务器 A' } as Host;
const other = { id: 'b', name: '服务器 B' } as Host;
const terminal = (connectionId: string, terminalSessionId: string, connected = true) => ({
  kind: 'ssh', connectionId, terminalSessionId, connected,
  connectionStatus: connected ? 'connected' : 'disconnected', manuallyClosed: false,
  host: connectionId === 'a' ? host : other,
}) as TerminalSession;
const binding = { target: { connectionId: 'a', terminalSessionId: 'old-a' } };

test('聊天名称与状态跟随绑定会话，切换 SSH 或本地页签不改变', () => {
  const a = terminal('a', 'old-a'), b = terminal('b', 'b');
  const local = { kind: 'local', connected: true } as TerminalSession;
  for (const active of [b, local, undefined]) {
    const value = resolveChatTarget(binding, [a, b], [host, other], active);
    assert.equal(value.host, host);
    assert.equal(value.connected, true);
    assert.equal(value.label, '服务器 A · 已绑定');
    assert.equal(value.localTerminal, false);
  }
});
test('原终端断开或已重连为新 ID，当前页签连接正常也不能冒充原绑定', () => {
  const b = terminal('b', 'b'), reopened = terminal('a', 'new-a');
  for (const sessions of [[terminal('a', 'old-a', false), b], [reopened, b], [b]]) {
    const value = resolveChatTarget(binding, sessions, [host, other], b);
    assert.equal(value.connected, false);
    assert.equal(value.label, '服务器 A · 已断开');
  }
  assert.equal(resolveChatTarget(binding, [], [], b).label, '原 SSH 会话 · 已断开');
});
test('纯文本历史始终未绑定，新对话仍跟随当前 SSH/本地选择', () => {
  const a = terminal('a', 'old-a');
  assert.deepEqual(resolveChatTarget({ target: null }, [a], [host], a), {
    host: undefined, connected: false, localTerminal: false, label: '未绑定 SSH · 文本对话',
  });
  assert.equal(resolveChatTarget(null, [a], [host], a).connected, true);
  assert.equal(resolveChatTarget(null, [], [], { kind: 'local' } as TerminalSession).localTerminal, true);
});
test('目标错误提示区分离线讨论与身份不符，保留历史', () => {
  assert.match(chatErrorGuidance('AGENT_TARGET_UNAVAILABLE'), /仍可讨论已有记录/);
  assert.match(chatErrorGuidance('AGENT_TARGET_MISMATCH'), /身份不一致.*历史已保留/);
});

const serverScope = {
  id:'scope-a',agentId:'model',userId:'default',revision:0,
  scope:{rootId:'root',kind:'server' as const,connectionId:'a',originTerminalId:'old-a',
    identity:{host:'a.example',port:22,username:'tester',hostKey:'SHA256:trusted'}},
};
const scopedA = {...terminal('a','new-a'),host:{...host,address:'a.example',user:'tester',port:22}};
test('默认普通对话不继承当前 SSH；打开、切换、关闭终端都可继续', () => {
  for(const active of [scopedA,terminal('b','b'),undefined]) {
    assert.equal(resolveScopeDisplay(undefined,[scopedA],[host],active).label,'普通对话');
    assert.equal(scopeTerminal(undefined,[scopedA],active),undefined);
  }
});
test('服务器任务重连按保存身份选择新终端，当前 B 不改变 A 的范围', () => {
  const b=terminal('b','b');
  assert.equal(scopeTerminal(serverScope,[scopedA,b],b),scopedA);
  assert.equal(resolveScopeDisplay(serverScope,[scopedA,b],[],b).label,'a.example · 服务器任务');
  assert.equal(resolveScopeDisplay(serverScope,[b],[],b).label,'a.example · 离线讨论');
});
test('同连接 ID 修改主机、端口或用户名不能冒充旧任务；旧身份仍显示', () => {
  for(const changed of [{address:'b.example'},{port:2222},{user:'other'}]) {
    const edited={...scopedA,host:{...scopedA.host,...changed}};
    assert.equal(scopeTerminal(serverScope,[edited],edited),undefined);
    assert.equal(resolveScopeDisplay(serverScope,[edited],[edited.host],edited).label,'a.example · 离线讨论');
  }
});


test('编辑连接配置不会让原有 PTY 被当成新主机，仍可选择创建任务时的真实终端', () => {
  const original={...scopedA,terminalSessionId:'old-a',host:{...scopedA.host,address:'edited.example',user:'changed'}};
  assert.equal(scopeTerminal(serverScope,[original],undefined),original);
  assert.equal(resolveScopeDisplay(serverScope,[original],[original.host]).label,'a.example · 服务器任务');
});
