import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { isTauriRuntime } from './runtime';
import { createClientUpdater, type UpdateConfiguration } from './clientUpdater';
import packageInfo from '../../package.json';

export const clientUpdater = createClientUpdater({
  configuration: () => isTauriRuntime() ? invoke<UpdateConfiguration>('client_update_status')
    : Promise.resolve({ version: packageInfo.version, configured: false, development: true, supported: false }),
  check: () => check({ timeout: 15_000 }),
  prepare: () => invoke<void>('prepare_client_update'),
});

export function useClientUpdater() {
  const snapshot = useSyncExternalStore(clientUpdater.subscribe, clientUpdater.getSnapshot);
  useEffect(() => { void clientUpdater.initialize(); }, []);
  return snapshot;
}

export function useStartupUpdateCheck(notify: (message: string) => void) {
  const snapshot = useClientUpdater();
  const announced = useRef('');
  useEffect(() => {
    const timer = setTimeout(() => { void clientUpdater.check(true); }, 10_000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (snapshot.phase !== 'available' || !snapshot.version || announced.current === snapshot.version) return;
    announced.current = snapshot.version;
    notify(`发现客户端新版本 ${snapshot.version}，可在设置 → 关于与更新中查看并下载。`);
  }, [snapshot.phase, snapshot.version, notify]);
}
