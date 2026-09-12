import { useCallback, useEffect, useRef, useState } from 'react';
import { sshApi, sshUserId, toHost, toRequest } from '../api/ssh';
import type { ConnectionDraft } from '../api/ssh';
import type { Host } from '../types';

type Metadata = Record<string, { environment?: string; favorite?: boolean }>;
const metadataKey = `agent-ssh-metadata-v1:${sshUserId}`;
function readMetadata(): Metadata {
  try { const value = JSON.parse(localStorage.getItem(metadataKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export function useSshConnections() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const metadata = useRef(readMetadata());
  const decorate = useCallback((host: Host): Host => ({ ...host, environment: metadata.current[host.id]?.environment || '开发', favorite: metadata.current[host.id]?.favorite === true }), []);
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return undefined;
    lock.current = true; setBusy(true); setError('');
    try { return await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'SSH 操作失败'); return undefined; }
    finally { lock.current = false; setBusy(false); }
  }, []);
  const refresh = useCallback(() => run(async () => {
    const rows = await sshApi.list();
    setHosts(rows.map(dto => decorate(toHost(dto)))); setLoaded(true); return true;
  }), [decorate, run]);
  useEffect(() => { void refresh(); }, [refresh]);
  const saveMetadata = (host: Host) => {
    metadata.current = { ...metadata.current, [host.id]: { environment: host.environment, favorite: host.favorite } };
    try { localStorage.setItem(metadataKey, JSON.stringify(metadata.current)); }
    catch { setError('连接操作已完成，但收藏偏好无法保存到本地。'); }
  };
  const save = (draft: ConnectionDraft) => run(async () => {
    const dto = await (draft.id ? sshApi.update(toRequest(draft)) : sshApi.create(toRequest(draft)));
    const host = { ...toHost(dto), environment: draft.environment, favorite: draft.favorite };
    saveMetadata(host);
    setHosts(previous => previous.some(item => item.id === host.id) ? previous.map(item => item.id === host.id ? host : item) : [...previous, host]);
    return host;
  });
  const detail = (id: string) => run(async () => decorate(toHost(await sshApi.get(id))));
  const connect = (id: string) => run(async () => {
    setHosts(previous => previous.map(host => host.id === id ? { ...host, online: false, status: 2 } : host));
    try { await sshApi.connect(id); }
    catch (cause) {
      setHosts(previous => previous.map(host => host.id === id ? { ...host, online: false, status: 3 } : host)); throw cause;
    }
    setHosts(previous => previous.map(host => host.id === id ? { ...host, online: true, status: 1 } : host)); return true;
  });
  const disconnect = (id: string) => run(async () => {
    await sshApi.disconnect(id);
    setHosts(previous => previous.map(host => host.id === id ? { ...host, online: false, status: 0 } : host)); return true;
  });
  const markDisconnected = (id: string) => {
    setHosts(previous => previous.map(host => host.id === id ? { ...host, online: false, status: 0 } : host));
  };
  const remove = (id: string) => run(async () => {
    // The delete endpoint does not close the live SSH session.
    await sshApi.disconnect(id);
    setHosts(previous => previous.map(host => host.id === id ? { ...host, online: false, status: 0 } : host));
    await sshApi.delete(id);
    setHosts(previous => previous.filter(host => host.id !== id)); return true;
  });
  const favorite = (host: Host) => {
    const updated = { ...host, favorite: !host.favorite }; saveMetadata(updated);
    setHosts(previous => previous.map(item => item.id === host.id ? updated : item));
  };
  return { hosts, busy, loaded, error, refresh, save, detail, connect, disconnect, markDisconnected, remove, favorite };
}
