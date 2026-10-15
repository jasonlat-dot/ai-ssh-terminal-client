import type { AgentSession } from '../api/agent';
import type { TerminalSession } from '../types';
import { scopeTerminal } from './chatTarget';
import { isSessionConnected } from './terminalSessions';

/** Mark only the exact live native session, never every tab sharing a saved SSH profile. */
export function agentBoundTerminalId(session:AgentSession|undefined,preparedId:string,terminals:TerminalSession[]) {
  const matches=(id:string)=>terminals.some(item=>item.kind==='ssh'&&item.terminalSessionId===id&&isSessionConnected(item)
    &&(!session?.scope?.connectionId||item.connectionId===session.scope.connectionId));
  const target=session?.task?.target?.terminalSessionId;
  return target&&matches(target)?target:preparedId&&matches(preparedId)?preparedId:undefined;
}

/** Keep a live tool target pinned. Reconnection can only select the saved server scope. */
export function executionTerminal(session: AgentSession | undefined, terminals: TerminalSession[], boundId: string) {
  const pinned = terminals.find(item => item.terminalSessionId === boundId
    && item.kind === 'ssh' && item.connectionId === session?.scope?.connectionId && isSessionConnected(item));
  return pinned ?? scopeTerminal(session, terminals);
}

/** Run between turns; the native binding checks the authenticated host key and account. */
export async function prepareExecutionBinding(
  session: AgentSession | undefined,
  terminal: TerminalSession | undefined,
  bind: (sessionId: string, terminalId: string) => Promise<AgentSession>,
): Promise<AgentSession> {
  if (!session || session.scope?.kind !== 'server' || !terminal || !isSessionConnected(terminal))
    throw new Error('SSH 工具目标已断开。请重连此对话对应的服务器后再执行命令。');
  if (terminal.kind !== 'ssh' || terminal.connectionId !== session.scope.connectionId)
    throw new Error('当前连接与此对话的服务器不一致，历史已保留。');
  if (session.task?.status === 'active' && session.task.target?.terminalSessionId === terminal.terminalSessionId
    && session.task.target.connectionId === terminal.connectionId) return session;
  // Native errors must stop the send. Never fall back to another server or replay old commands.
  const rebound = await bind(session.id, terminal.terminalSessionId);
  if (rebound.id !== session.id || rebound.task?.status !== 'active'
    || rebound.task.target?.terminalSessionId !== terminal.terminalSessionId
    || rebound.task.target.connectionId !== terminal.connectionId)
    throw new Error('SSH 工具目标未确认，请检查连接后重试。');
  return rebound;
}
