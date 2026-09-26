type ReadJob = {
  signal: AbortSignal;
  foreground: () => boolean;
  start: () => void;
};

// HTTP/1.x browsers commonly allow six connections per origin. Long Polls must
// leave room for /connect, /open, keyboard writes, Agent streams and other APIs.
const MAX_CONCURRENT_READS = 3;
const MAX_BACKGROUND_READS = 2;

class TerminalReadScheduler {
  private pending: ReadJob[] = [];
  private active = new Set<ReadJob>();

  run<T>(read: () => Promise<T>, signal: AbortSignal, foreground: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const cancelQueued = () => {
        this.pending = this.pending.filter(item => item !== job);
        reject(signal.reason);
        this.drain();
      };
      const job: ReadJob = {
        signal,
        foreground,
        start: () => {
          signal.removeEventListener('abort', cancelQueued);
          this.active.add(job);
          // Keep the slot until the response body is consumed, including errors.
          void Promise.resolve().then(read).then(resolve, reject).finally(() => {
            this.active.delete(job);
            this.drain();
          });
        },
      };
      this.pending.push(job);
      signal.addEventListener('abort', cancelQueued, { once: true });
      this.drain();
    });
  }

  prioritize() { this.drain(); }

  private drain() {
    while (this.active.size < MAX_CONCURRENT_READS) {
      let index = this.pending.findIndex(job => !job.signal.aborted && job.foreground());
      if (index < 0) {
        const backgroundCount = [...this.active].filter(job => !job.foreground()).length;
        if (backgroundCount >= MAX_BACKGROUND_READS) return;
        index = this.pending.findIndex(job => !job.signal.aborted);
      }
      if (index < 0) return;
      this.pending.splice(index, 1)[0].start();
    }
  }
}

export const terminalReadScheduler = new TerminalReadScheduler();
