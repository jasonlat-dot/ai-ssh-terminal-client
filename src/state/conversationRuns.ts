import type { AgentContextStatus } from '../api/agentContext';
import type { ChatMessage } from '../types';

export type ConversationOutcome = 'success' | 'error';

/** A stream owns its messages and cancellation independently of the selected page. */
export interface ConversationRun {
  requestId: string;
  agentId: string;
  sessionId: string;
  controller: AbortController;
  messages: ChatMessage[];
  context?: AgentContextStatus;
  stopping: boolean;
}

export class ConversationRuns {
  private runs = new Map<string, ConversationRun>();
  private unread = new Map<string, ConversationOutcome>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  private changed() { this.revision++; this.listeners.forEach(listener => listener()); }
  get(sessionId: string) { return [...this.runs.values()].find(run => run.sessionId === sessionId); }
  get active() { return [...this.runs.values()]; }
  get unreadResults(): ReadonlyMap<string, ConversationOutcome> { return this.unread; }
  acknowledge(sessionId: string) {
    if (this.unread.delete(sessionId)) this.changed();
  }
  start(run: ConversationRun) {
    if (this.get(run.sessionId)) throw new Error('此会话已有正在运行的任务。');
    this.runs.set(run.requestId, run); this.changed();
    return run;
  }
  bind(run: ConversationRun, sessionId: string) {
    if (this.runs.get(run.requestId) !== run) return;
    const previous = this.get(sessionId);
    if (previous && previous !== run) throw new Error('此会话已有正在运行的任务。');
    run.sessionId = sessionId; this.changed();
  }
  stop(run: ConversationRun) {
    if (this.runs.get(run.requestId) !== run || run.stopping) return false;
    run.stopping = true; this.changed(); return true;
  }
  finish(run: ConversationRun, outcome?: ConversationOutcome, viewed = false) {
    if (this.runs.get(run.requestId) !== run) return;
    this.runs.delete(run.requestId);
    if (outcome && run.sessionId && !viewed && !run.stopping && !run.controller.signal.aborted)
      this.unread.set(run.sessionId, outcome);
    this.changed();
  }
  dispose() {
    this.runs.forEach(run => run.controller.abort());
    this.runs.clear(); this.unread.clear(); this.changed();
  }
}
