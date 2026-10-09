import { useCallback, useEffect, useRef, useState } from 'react';
import { probeBackendHealth, type BackendHealthSnapshot } from '../api/health';
import { DEFAULT_HEALTH_REFRESH, type HealthRefreshPreferences } from '../config/health';

/** 当前连接与内置服务复用同一探测流程；定时复查不会闪烁已有状态。 */
export function useBackendHealth(backendUrl: string | null, refreshKey?: string, autoProbe = true,
  preferences: HealthRefreshPreferences = DEFAULT_HEALTH_REFRESH) {
  const [snapshot, setSnapshot] = useState<BackendHealthSnapshot | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const snapshotRef = useRef<BackendHealthSnapshot | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<Promise<BackendHealthSnapshot | undefined> | null>(null);

  const probe = useCallback((quiet = false): Promise<BackendHealthSnapshot | undefined> => {
    if (!backendUrl) {
      setError('暂未读取到服务地址，请稍后重新检查。');
      return Promise.resolve(undefined);
    }
    if (!quiet || !snapshotRef.current) setProbing(true);
    // 按钮始终可点击；重复点击及自动刷新共用正在进行的请求。
    if (pendingRef.current) return pendingRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    const request = (async () => {
      try {
        const next = await probeBackendHealth({ backendUrl, signal: controller.signal });
        if (controller.signal.aborted || abortRef.current !== controller) return;
        snapshotRef.current = next;
        setSnapshot(next);
        return next;
      } catch (cause) {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        snapshotRef.current = null;
        setSnapshot(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          pendingRef.current = null;
          setProbing(false);
        }
      }
    })();
    pendingRef.current = request;
    return request;
  }, [backendUrl]);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setError('');
    setProbing(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      pendingRef.current = null;
    };
  }, [backendUrl, refreshKey]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      const next = await probe(true);
      if (!active) return;
      // 启动中/未就绪时尽快复查；正常运行后降低频率。
      const seconds = next?.ok ? preferences.normalIntervalSeconds : preferences.retryIntervalSeconds;
      timer = window.setTimeout(() => { void refresh(); }, seconds * 1000);
    };
    if (backendUrl && autoProbe && preferences.enabled) void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [backendUrl, refreshKey, autoProbe, probe, preferences.enabled, preferences.normalIntervalSeconds, preferences.retryIntervalSeconds]);

  return { snapshot, probing, error, probe };
}
