import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../state/runtime';

/** 桌面壳内置后端的启动状态；浏览器开发模式不提供该状态。 */
export type BundledBackendStatus = {
  status: 'starting' | 'running' | 'failed' | 'stopped';
  message: string;
  logPath: string | null;
};

export type BundledBackendConfigValue = {
  value: string;
  sourceFile: string;
  environmentOverride: string | null;
  configured: boolean;
  sensitive: boolean;
};

/** 内置后端设置页使用的真实 YAML 配置快照。 */
export type BundledBackendConfig = {
  configDirectory: string;
  applicationFile: string;
  activeProfiles: string[];
  values: Record<string, BundledBackendConfigValue>;
  sqliteFile: string;
  uploadDirectory: string;
  logDirectory: string;
};

export type BundledBackendConfigUpdate = {
  /** 只接受 Rust 侧白名单中的逻辑字段名；敏感字段空值表示保留原配置。 */
  values: Record<string, string>;
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

/** 读取当前活动 Profile 下真正生效的内置后端配置。 */
export async function readBundledBackendConfig(): Promise<BundledBackendConfig | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendConfig>('bundled_backend_config');
}

/** 精确更新字段对应的 application*.yml，不覆盖整份配置文件。 */
export async function saveBundledBackendConfig(update: BundledBackendConfigUpdate): Promise<BundledBackendConfig | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendConfig>('bundled_backend_save_config', { update });
}
