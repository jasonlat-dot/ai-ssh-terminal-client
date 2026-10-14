import type { Host, TerminalSession } from '../types';
import { isSessionConnected } from './terminalSessions';

type Target = { connectionId: string; terminalSessionId: string };
/** The chat's persisted binding wins over whichever terminal tab is currently visible. */
export function resolveChatTarget(
  chat: { target: Target | null } | null,
  sessions: TerminalSession[],
  hosts: Host[],
  active?: TerminalSession,
) {
  if (!chat) return {
    host: active?.kind === 'ssh' ? active.host : undefined,
    connected: active?.kind === 'ssh' && isSessionConnected(active),
    localTerminal: active?.kind === 'local',
    label: undefined,
  };
  if (!chat.target) return {
    host: undefined, connected: false, localTerminal: false, label: '未绑定 SSH · 文本对话',
  };
  const target = chat.target;
  const terminal = sessions.find(session => session.kind === 'ssh'
    && session.connectionId === target.connectionId && session.terminalSessionId === target.terminalSessionId);
  const host = terminal?.host ?? hosts.find(item => item.id === target.connectionId);
  const connected = isSessionConnected(terminal);
  return {
    host, connected, localTerminal: false,
    label: (host?.name ?? '原 SSH 会话') + (connected ? ' · 已绑定' : ' · 已断开'),
  };
}

import type { AgentSession } from '../api/agent';
export function scopeTerminal(chat:AgentSession|undefined, sessions:TerminalSession[], active?:TerminalSession) {
  const scope=chat?.scope;
  if(scope?.kind!=='server' || !scope.identity) return undefined;
  const expected=scope.identity;
  const matching=(session:TerminalSession|undefined)=>Boolean(session?.kind==='ssh'
    && session.connectionId===scope.connectionId && isSessionConnected(session)
    && session.host.address.replace(/^\[|\]$/g,'').toLowerCase()===expected.host
    && (session.host.port??22)===expected.port && session.host.user===expected.username);
  const origin=sessions.find(session=>session.kind==='ssh' && session.connectionId===scope.connectionId
    && session.terminalSessionId===scope.originTerminalId && isSessionConnected(session));
  return matching(active)?active:origin??sessions.find(matching);
}
export function resolveScopeDisplay(chat:AgentSession|undefined,sessions:TerminalSession[],hosts:Host[],active?:TerminalSession) {
  if(!chat || chat.scope?.kind==='general' || (!chat.scope && !chat.task?.target))
    return {host:undefined,connected:false,localTerminal:false,label:'普通对话'};
  if(!chat.scope) return resolveChatTarget({target:chat.task?.target??null},sessions,hosts,active);
  const scope=chat.scope, terminal=scopeTerminal(chat,sessions,active);
  const host=hosts.find(item=>item.id===scope.connectionId);
  // The address is durable identity; an edited profile name alone must not describe a different machine.
  const identity=scope.identity;
  const name=host && identity && host.address.replace(/^\[|\]$/g,'').toLowerCase()===identity.host
    && (host.port??22)===identity.port && host.user===identity.username ? host.name : identity?.host??'原服务器';
  return {host,connected:Boolean(terminal),localTerminal:false,label:name+(terminal?' · 服务器任务':' · 离线讨论')};
}
export function scopeLabel(session:AgentSession,hosts:Host[] = []) {
  if(session.scope?.kind==='general') return '普通对话';
  const identity=session.scope?.identity;
  const configured=hosts.find(host=>host.id===session.scope?.connectionId && identity && host.address.toLowerCase()===identity.host && (host.port??22)===identity.port && host.user===identity.username);
  const name=configured?.name ?? (identity?identity.host+':'+identity.port+' ('+identity.username+')':'旧服务器会话');
  return name+' · '+(session.task?.goal.slice(0,36)||'服务器任务');
}
