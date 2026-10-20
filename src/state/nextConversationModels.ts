export interface NextConversationModel {
  currentId: string;
  modelId: string;
  saving: boolean;
  error?: string;
  attemptedId?: string;
}

/** Next-turn preferences never change the identity of an in-flight request. */
export class NextConversationModels {
  private choices = new Map<string, NextConversationModel>();
  private committed = new Map<string, string>();
  private jobs = new Map<string, Promise<boolean>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  disposed = false;
  lifecycle = 0;
  activate() { this.disposed = false; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  private changed() { this.revision++; this.listeners.forEach(listener => listener()); }
  get(sessionId: string) { return this.choices.get(sessionId); }
  get saving() { return [...this.choices.values()].some(choice => choice.saving); }
  settled(sessionId: string) { return this.jobs.get(sessionId) ?? Promise.resolve(true); }
  currentId(sessionId: string, fallback: string) { return this.get(sessionId)?.currentId ?? this.committed.get(sessionId) ?? fallback; }
  select(sessionId: string, currentId: string, modelId: string) {
    if (this.disposed) return;
    const previous = this.get(sessionId);
    if (!previous?.saving && !previous?.attemptedId && modelId === (previous?.currentId ?? currentId)) this.choices.delete(sessionId);
    else this.choices.set(sessionId, { currentId: previous?.currentId ?? currentId, modelId, saving: !!previous?.saving, attemptedId: previous?.attemptedId });
    this.changed();
  }
  apply(sessionId: string, change: (previous: string, next: string, attempted?: string) => Promise<void>): Promise<boolean> {
    const existing = this.jobs.get(sessionId);
    if (existing) return existing;
    const lifecycle = this.lifecycle;
    const active = () => !this.disposed && lifecycle === this.lifecycle;
    const job = (async () => {
      // Start after the job has been registered, even when no network call is needed.
      await Promise.resolve();
      while (active()) {
        const choice = this.get(sessionId);
        if (!choice) return true;
        const { currentId, modelId, attemptedId } = choice;
        this.choices.set(sessionId, { ...choice, saving: true, error: undefined }); this.changed();
        try {
          if (attemptedId) await change(currentId, modelId, attemptedId);
          else if (currentId !== modelId) await change(currentId, modelId);
        } catch (error) {
          if (!active()) return false;
          const latest = this.get(sessionId);
          if (latest) this.choices.set(sessionId, { ...latest, saving: false, attemptedId: modelId === currentId ? attemptedId : modelId, error: error instanceof Error ? error.message : '切换模型失败，请重试。' });
          this.changed(); return false;
        }
        if (!active()) return false;
        this.committed.set(sessionId, modelId);
        const latest = this.get(sessionId);
        if (!latest || latest.modelId === modelId) this.choices.delete(sessionId);
        else this.choices.set(sessionId, { ...latest, currentId: modelId, saving: false, attemptedId: undefined });
        this.changed();
      }
      return false;
    })().finally(() => { if (this.jobs.get(sessionId) === job) this.jobs.delete(sessionId); });
    this.jobs.set(sessionId, job);
    return job;
  }
  dispose() { this.disposed = true; this.lifecycle++; this.jobs.clear(); this.choices.clear(); this.committed.clear(); this.changed(); }
}
