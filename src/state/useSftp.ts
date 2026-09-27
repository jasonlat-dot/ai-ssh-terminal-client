import { useCallback, useEffect, useRef, useState } from 'react';
import { sftpApi, SftpError } from '../api/sftp';
import type { LocalDirectory, SftpEntry, SftpEvent, SftpSession, SftpTransfer } from '../api/sftp';
import { mergeTask, remoteChild } from './sftp';

export function useSftp(connectionId: string) {
  const [session, setSession] = useState<SftpSession | null>(null);
  const sessionRef = useRef<SftpSession | null>(null);
  const [phase, setPhase] = useState<'idle' | 'opening' | 'ready' | 'closed' | 'closing'>('idle');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('等待连接');
  const [local, setLocal] = useState<LocalDirectory | null>(null);
  const [remotePath, setRemotePath] = useState('');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [tasks, setTasks] = useState<SftpTransfer[]>([]);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const [localBytes, setLocalBytes] = useState<Record<string, Record<string, number>>>({});
  const [scanning, setScanning] = useState('');
  const [working, setWorking] = useState(false);
  const workLock = useRef(false);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const localVersion = useRef(0);
  const remoteVersion = useRef(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const refreshPending = useRef(false);
  const refreshAgain = useRef(false);

  const fail = useCallback((e: unknown) => {
    if (!mounted.current) return;
    setError(e instanceof Error ? e.message : String(e));
  }, []);
  const loadLocal = useCallback(async (path?: string) => {
    const version = ++localVersion.current;
    setLocalLoading(true);
    try {
      const result = await sftpApi.local(path);
      if (version === localVersion.current && mounted.current) setLocal(result);
    } catch (e) { if (version === localVersion.current) fail(e); }
    finally { if (version === localVersion.current && mounted.current) setLocalLoading(false); }
  }, [fail]);
  const loadRemote = useCallback(async (path: string, current = sessionRef.current) => {
    if (!current) return;
    const version = ++remoteVersion.current;
    setRemoteLoading(true);
    try {
      const result = await sftpApi.entries(current.sftpSessionId, path);
      if (version === remoteVersion.current && mounted.current && current === sessionRef.current) {
        setEntries(result.sort((a, b) => Number(b.kind === 'DIRECTORY') - Number(a.kind === 'DIRECTORY') || a.name.localeCompare(b.name)));
        setRemotePath(path);
      }
    } catch (e) { if (version === remoteVersion.current) fail(e); }
    finally { if (version === remoteVersion.current && mounted.current) setRemoteLoading(false); }
  }, [fail]);

  const refreshTasks = useCallback(async () => {
    if (refreshPending.current) { refreshAgain.current = true; return; }
    refreshPending.current = true;
    try {
      do {
        refreshAgain.current = false;
        const current = sessionRef.current;
        if (!current) break;
        const result = await sftpApi.tasks(current.sftpSessionId);
        if (mounted.current && current === sessionRef.current) {
          setTasks(previous => result.reduce(mergeTask, previous.filter(task => result.some(next => next.transferId === task.transferId))));
        }
      } while (refreshAgain.current);
    } catch (e) {
      if (e instanceof SftpError && e.status === 404 && mounted.current) setPhase('closed');
      fail(e);
    } finally { refreshPending.current = false; }
  }, [fail]);
  const receive = useCallback((event: SftpEvent) => {
    if (!mounted.current) return;
    if (event.type === 'task') {
      if (!tasksRef.current.some(task => task.transferId === event.data.transferId)) setScanning('');
      setTasks(previous => mergeTask(previous, event.data));
    } else if (event.type === 'progress') {
      const changed = tasksRef.current.some(task => !event.data.some(next => next.transferId === task.transferId)) || event.data.some(next => {
        const old = tasksRef.current.find(task => task.transferId === next.transferId)?.progress;
        return !old || old.status !== next.status || old.completedItems !== next.completedItems || old.failedItems !== next.failedItems || old.awaitingConfirmation !== next.awaitingConfirmation;
      });
      setTasks(previous => previous.map(task => {
        const progress = event.data.find(next => next.transferId === task.transferId);
        return progress && Date.parse(progress.updatedAt) >= Date.parse(task.progress.updatedAt) ? { ...task, progress } : task;
      }));
      if (changed) void refreshTasks();
    } else if (event.type === 'local-progress') {
      setLocalBytes(previous => ({ ...previous, [event.data.transferId]: { ...previous[event.data.transferId], [event.data.itemId]: event.data.bytes } }));
    } else if (event.type === 'connection') {
      setConnection(event.data);
      if (event.data === '进度已连接') void refreshTasks();
    } else if (event.type === 'session-closed') {
      setPhase('closed'); setConnection('文件管理会话已结束');
    } else if (event.type === 'error') {
      setTaskErrors(previous => ({ ...previous, [event.data.transferId]: event.data.message }));
    }
  }, [refreshTasks]);

  useEffect(() => {
    mounted.current = true;
    void loadLocal();
    return () => {
      mounted.current = false; generation.current++;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void sftpApi.close(current.sftpSessionId).catch(console.warn);
    };
  }, [loadLocal]);

  const open = async (root: string) => {
    if (phase === 'opening' || phase === 'closing') return;
    const version = ++generation.current;
    setPhase('opening'); setError('');
    try {
      const previous = sessionRef.current;
      if (previous) await sftpApi.close(previous.sftpSessionId);
      sessionRef.current = null;
      setTasks([]); setTaskErrors({}); setLocalBytes({}); setEntries([]);
      const current = await sftpApi.open(connectionId, root, event => { if (version === generation.current) receive(event); });
      if (!mounted.current || version !== generation.current) { await sftpApi.close(current.sftpSessionId); return; }
      sessionRef.current = current;
      setSession(current); setPhase('ready');
      await loadRemote(current.rootPath, current);
      void refreshTasks();
    } catch (e) { fail(e); if (mounted.current) setPhase('closed'); }
  };
  const close = async (): Promise<boolean> => {
    setPhase('closing');
    try {
      if (sessionRef.current) await sftpApi.close(sessionRef.current.sftpSessionId);
      sessionRef.current = null; generation.current++;
      setSession(null); setPhase('closed');
      return true;
    } catch (e) { fail(e); setPhase('closed'); return false; }
  };
  const transfer = async (direction: 'UPLOAD' | 'DOWNLOAD', localPath: string, remote: string, conflict: 'FAIL' | 'SKIP') => {
    if (!sessionRef.current || workLock.current) return;
    workLock.current = true; setWorking(true); setError('');
    setScanning(direction === 'DOWNLOAD' ? '正在扫描远程文件…' : '正在扫描本地文件…');
    try { await sftpApi.transfer(sessionRef.current.sftpSessionId, direction, localPath, remote, conflict); }
    catch (e) { fail(e); }
    finally {
      workLock.current = false;
      if (mounted.current) {
        setScanning(''); setWorking(false);
        void refreshTasks();
        if (local) void loadLocal(local.path);
        if (remotePath) void loadRemote(remotePath);
      }
    }
  };
  const retry = async (id: string) => {
    if (!sessionRef.current || workLock.current) return;
    workLock.current = true; setWorking(true); setError('');
    setTaskErrors(previous => ({ ...previous, [id]: '' }));
    try { await sftpApi.retry(sessionRef.current.sftpSessionId, id); }
    catch (e) { fail(e); }
    finally {
      workLock.current = false;
      if (mounted.current) { setWorking(false); void refreshTasks(); if (local) void loadLocal(local.path); if (remotePath) void loadRemote(remotePath); }
    }
  };
  const cancel = async (id: string) => {
    if (!sessionRef.current) return;
    setCancelling(previous => [...previous, id]);
    try { await sftpApi.cancel(sessionRef.current.sftpSessionId, id); }
    catch (e) { fail(e); }
    finally { if (mounted.current) setCancelling(previous => previous.filter(value => value !== id)); }
  };
  const mkdir = async (side: 'local' | 'remote', name: string): Promise<boolean> => {
    try {
      if (side === 'local' && local) { await sftpApi.localMkdir(local.path, name); await loadLocal(local.path); }
      else if (side === 'remote' && sessionRef.current) { await sftpApi.mkdir(sessionRef.current.sftpSessionId, remoteChild(remotePath, name)); await loadRemote(remotePath); }
      else return false;
      return true;
    } catch (e) { fail(e); return false; }
  };
  return { session, phase, error, setError, connection, local, remotePath, entries, localLoading, remoteLoading, tasks, taskErrors, localBytes, scanning, working, cancelling, open, close, loadLocal, loadRemote, refreshTasks, transfer, retry, cancel, mkdir };
}
