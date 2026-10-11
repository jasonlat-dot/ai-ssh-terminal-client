export type UpdateConfiguration = { version: string; configured: boolean; development: boolean; supported: boolean };
export type UpdateDownloadEvent = { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } } | { event: 'Finished' };
export type UpdateResource = {
  version: string; body?: string; date?: string;
  download: (progress: (event: UpdateDownloadEvent) => void, options?: { timeout: number }) => Promise<void>;
  install: (options?: { restartAfterInstall: boolean }) => Promise<void>;
  close: () => Promise<void>;
};
export type UpdatePhase = 'idle' | 'initializing' | 'disabled' | 'checking' | 'current' | 'available'
  | 'downloading' | 'downloaded' | 'preparing' | 'installing' | 'error';
export type UpdateSnapshot = {
  phase: UpdatePhase; config: UpdateConfiguration | null; version: string; notes: string; date?: string;
  downloaded: number; total: number | null; verified: boolean; error: string; checkedAt: number | null;
};
type Dependencies = {
  configuration: () => Promise<UpdateConfiguration>;
  check: () => Promise<UpdateResource | null>;
  prepare: () => Promise<void>;
  now?: () => number;
};

/** One resource/operation for the whole app, including settings remounts and StrictMode. */
export function createClientUpdater(deps: Dependencies) {
  let snapshot: UpdateSnapshot = { phase: 'idle', config: null, version: '', notes: '', downloaded: 0,
    total: null, verified: false, error: '', checkedAt: null };
  const listeners = new Set<() => void>();
  let initialization: Promise<void> | null = null;
  let resource: UpdateResource | null = null;
  let busy = false, startupChecked = false;
  const publish = (patch: Partial<UpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener());
  };
  const usable = () => snapshot.config?.configured && snapshot.config.supported && !snapshot.config.development;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const release = async () => { const previous = resource; resource = null; await previous?.close(); };
  const initialize = () => {
    if (initialization) return initialization;
    publish({ phase: 'initializing', error: '' });
    initialization = deps.configuration().then(config => {
      publish({ config, phase: config.configured && config.supported && !config.development ? 'idle' : 'disabled' });
    }).catch(error => {
      initialization = null; publish({ phase: 'error', error: `读取更新配置失败：${message(error)}` });
    });
    return initialization;
  };
  const check = async (automatic = false) => {
    if (busy || snapshot.verified || (automatic && startupChecked)) return;
    if (automatic) startupChecked = true;
    busy = true;
    try {
      await initialize();
      if (!usable()) return;
      publish({ phase: 'checking', error: '', verified: false, version: '', notes: '', date: undefined, downloaded: 0, total: null });
      await release();
      const next = await deps.check();
      resource = next;
      publish({ phase: next ? 'available' : 'current', version: next?.version ?? '', notes: next?.body ?? '',
        date: next?.date, downloaded: 0, total: null, checkedAt: (deps.now ?? Date.now)() });
    } catch (error) {
      publish({ phase: 'error', error: `检查更新失败：${message(error)}。请检查网络，或确认发布者已上传 latest.json。` });
    } finally { busy = false; }
  };
  const download = async () => {
    if (busy || !resource || !usable() || snapshot.verified) return;
    busy = true;
    const current = resource;
    publish({ phase: 'downloading', downloaded: 0, total: null, error: '' });
    try {
      await current.download(event => {
        if (event.event === 'Started') publish({ total: event.data.contentLength && event.data.contentLength > 0 ? event.data.contentLength : null });
        if (event.event === 'Progress') publish({ downloaded: snapshot.downloaded + event.data.chunkLength });
        // Finished is a download progress event, not permission to bypass signature verification.
      }, { timeout: 120_000 });
      // The updater resolves download only after it verifies the artifact with the baked-in public key.
      publish({ phase: 'downloaded', verified: true });
    } catch (error) {
      publish({ phase: 'error', verified: false, error: `下载或签名校验失败：${message(error)}。未安装更新，可重试下载。` });
    } finally { busy = false; }
  };
  const install = async (beforeInstall: () => Promise<void>) => {
    if (busy || !resource || !usable() || !snapshot.verified) return;
    busy = true;
    publish({ phase: 'preparing', error: '' });
    try {
      // User confirmation is required by the UI; failed persistence aborts before native shutdown.
      await beforeInstall();
      await deps.prepare();
      publish({ phase: 'installing' });
      await resource.install({ restartAfterInstall: true });
    } catch (error) {
      publish({ phase: 'error', error: `安装更新失败：${message(error)}。若会话或内置服务已停止，请重新打开或启动。` });
    } finally { busy = false; }
  };
  const discard = async () => {
    if (busy) return;
    busy = true;
    try {
      publish({ phase: usable() ? 'idle' : 'disabled', version: '', notes: '', date: undefined,
        downloaded: 0, total: null, verified: false, error: '' });
      await release();
    } catch (error) { publish({ phase: 'error', error: `释放更新失败：${message(error)}` }); }
    finally { busy = false; }
  };
  return { initialize, check, download, install, discard,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
