import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../state/runtime';

/** 桌面壳内置后端的启动状态；浏览器开发模式不提供该状态。 */
export type BundledBackendStatus = {
  status: 'starting' | 'running' | 'failed' | 'stopped';
  message: string;
  logPath: string | null;
  /** 本次启动实际监听的地址；旧版本桌面壳可能不提供。 */
  backendUrl?: string | null;
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
  /** 后端有效 TLS 配置；旧壳未提供时保留 HTTP 回退行为。 */
  sslEnabled?: boolean;
};

export type BundledBackendConfigUpdate = {
  /** 只接受 Rust 侧白名单中的逻辑字段名；敏感字段空值表示保留原配置。 */
  values: Record<string, string>;
};

/** 优先使用运行中的真实地址；旧壳或启动期间回退到已保存配置中的端口。 */
export function resolveBundledBackendUrl(status: BundledBackendStatus | null, config: BundledBackendConfig | null): string | null {
  if (status?.backendUrl) return status.backendUrl;
  const port = Number(config?.values.serverPort?.value);
  const scheme = config?.sslEnabled ? 'https' : 'http';
  return Number.isInteger(port) && port > 0 && port <= 65535 ? `${scheme}://127.0.0.1:${port}` : null;
}

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

/**
 * 立即停止内置后端。
 * 不影响“自动启动”偏好——偏好只决定“客户端启动时是否自动拉起”，
 * 跟用户当前想不想让它跑是两件事。
 */
export async function stopBundledBackend(): Promise<BundledBackendStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendStatus>('bundled_backend_stop');
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

/**
 * “自动启动内置后端”开关状态。
 *
 * - true（默认）：Tauri 启动时自动拉起本地 Java，无需用户介入。
 * - false：Tauri 启动时停在 stopped 状态，前端在启动页和设置页给出“启动”按钮。
 */
export async function readBundledBackendAutoStart(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  return invoke<boolean>('bundled_backend_get_auto_start');
}

/** 切换自动启动开关。关闭时如果本地后端正在运行，会被立即 kill。 */
export async function setBundledBackendAutoStart(enabled: boolean): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  return invoke<boolean>('bundled_backend_set_auto_start', { enabled });
}
