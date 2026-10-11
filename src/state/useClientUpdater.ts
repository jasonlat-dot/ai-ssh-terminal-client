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

export function useStartupUpdateCheck(onAvailable: (version: string) => void) {
  const callback = useRef(onAvailable);
  callback.current = onAvailable;
  useEffect(() => {
    let active = true;
    // The app root stays mounted across startup, settings and backend changes.
    // Only a successful automatic check announces an update; failures stay silent.
    const timer = setTimeout(() => {
      void clientUpdater.check(true).then(version => {
        if (active && version) callback.current(version);
      });
    }, 3_000);
    return () => { active = false; clearTimeout(timer); };
  }, []);
}
