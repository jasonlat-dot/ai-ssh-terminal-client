import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../state/runtime';

/** 桌面壳内置后端的启动状态；浏览器开发模式不提供该状态。 */
export type BundledBackendStatus = {
  status: 'starting' | 'running' | 'failed' | 'stopped';
  message: string;
  logPath: string | null;
};

/** 查询 Tauri 启动阶段保存的后端结果，避免只能从接口网络错误间接判断。 */
export async function readBundledBackendStatus(): Promise<BundledBackendStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendStatus>('bundled_backend_status');
}

/** 重新读取外置配置并启动内置后端。 */
export async function restartBundledBackend(): Promise<BundledBackendStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendStatus>('bundled_backend_restart');
}
