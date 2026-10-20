import type { ResourceSnapshot } from '../api/terminal';

/** One request at a time. Hidden pages abort probes; late responses cannot update another session. */
export function watchTerminalResources(load: (signal: AbortSignal) => Promise<ResourceSnapshot>,
  receive: (sample: ResourceSnapshot) => void, failed: (error: unknown) => void) {
  let stopped = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  const cancel = () => { generation++; clearTimeout(timer); pending?.abort(); pending = undefined; };
  const refresh = () => {
    if (stopped || document.hidden || pending) return;
    clearTimeout(timer);
    const controller = new AbortController(), current = ++generation;
    pending = controller;
    void (async () => {
      let delay = 5_000;
      try {
        const sample = await load(controller.signal);
        if (stopped || current !== generation) return;
        receive(sample);
        if (!sample.supported) { delay = 0; return; }
        if (sample.stale) delay = 15_000;
      } catch (error) {
        if (stopped || current !== generation || controller.signal.aborted) return;
        failed(error); delay = 15_000;
      } finally {
        if (!stopped && current === generation) {
          pending = undefined;
          // Unsupported hosts wait for an explicit refresh or visibility change.
          if (!document.hidden && delay > 0) timer = setTimeout(refresh, delay);
        }
      }
    })();
  };
  const visibility = () => { cancel(); if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', visibility);
  refresh();
  return { refresh, stop() { stopped = true; cancel(); document.removeEventListener('visibilitychange', visibility); } };
}

export function resourceBytes(value: number | null | undefined, rate = false): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit > 0 && value < 10 ? 1 : 0)} ${units[unit]}${rate ? '/s' : ''}`;
}
export function resourcePercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.max(0, Math.min(100, value)).toFixed(value < 10 ? 1 : 0)}%`;
}
export function resourceUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}天 ${hours}时` : hours ? `${hours}时 ${minutes}分` : `${minutes}分`;
}
