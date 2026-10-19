import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../state/runtime';

/** 桌面壳内置后端的启动状态；浏览器开发模式不提供该状态。 */
export type BundledBackendStatus = {
  /** Rust 在真实状态变化时递增，用来避免旧快照覆盖新通知。 */
  revision: number;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  message: string;
  logPath: string | null;
  /** Rust 模式为 ipc://builtin/<实例ID>，用于隔离重启前后的请求，不是监听地址。 */
  backendUrl?: string | null;
  engine?: string;
};

export type BundledBackendConfigValue = {
  value: string;
  sourceFile: string;
  environmentOverride: string | null;
  configured: boolean;
  sensitive: boolean;
};

/** 应用数据设置使用的真实 JSON 配置快照。 */
export type BundledBackendConfig = {
  configDirectory: string;
  applicationFile: string;
  activeProfiles: string[];
  values: Record<string, BundledBackendConfigValue>;
  sqliteFile: string;
  uploadDirectory: string;
  logDirectory: string;
  traceLogDirectory?: string;
  engine?: string;
};

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type BundledBackendConfigUpdate = {
  /** 只接受 Rust 侧白名单中的逻辑字段名；敏感字段空值表示保留原配置。 */
  values: Record<string, string>;
};

/** 查询 Tauri 启动阶段保存的后端结果，避免只能从接口网络错误间接判断。 */
export async function readBundledBackendStatus(): Promise<BundledBackendStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendStatus>('bundled_backend_status');
}

/**
 * 订阅内置服务状态，替代前端的固定间隔轮询。
 *
 * @param onStatus 首次快照或新版本事件的接收函数；工作区就绪检查通过 IPC 完成。
 * @param onError 订阅失败或未收到任何状态时的首次查询错误。
 * @returns 同步的取消函数，供 React effect 清理使用，包括“监听尚未注册完成就卸载”。
 *
 * 先安装监听，再读取快照：启动可能在 WebView 绘制前结束，单靠事件会漏掉它；
 * 快照也可能比新事件更晚到达，因此两条路径共享版本号过滤，不重复刷新页面。
 */
export function watchBundledBackendStatus(
  onStatus: (status: BundledBackendStatus | null) => void,
  onError?: (cause: unknown) => void,
): UnlistenFn {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  let latestRevision = -1;
  let receivedStatus = false;
  const deliver = (status: BundledBackendStatus | null) => {
    if (disposed) return;
    if (status) {
      if (status.revision <= latestRevision) return;
      latestRevision = status.revision;
    } else if (receivedStatus) return;
    receivedStatus = true;
    onStatus(status);
  };

  void (async () => {
    try {
      const release = await listen<BundledBackendStatus>('bundled-backend-status-changed', event => deliver(event.payload));
      if (disposed) { release(); return; }
      unlisten = release;
      deliver(await readBundledBackendStatus());
    } catch (cause) {
      // 若已经收到新事件，不要用较晚失败的初始查询把正常状态清空。
      if (!disposed && !receivedStatus) onError?.(cause);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
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

/** 按字段更新 workspace.json 中的应用数据设置。 */
export async function saveBundledBackendConfig(update: BundledBackendConfigUpdate): Promise<BundledBackendConfig | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BundledBackendConfig>('bundled_backend_save_config', { update });
}

/**
 * “自动启动内置后端”开关状态。
 *
 * - true（默认）：Tauri 启动时自动初始化本地 Rust 功能，无需用户介入。
 * - false：Tauri 启动时停在 stopped 状态，前端在启动页和设置页给出“启动”按钮。
 */
export async function readBundledBackendAutoStart(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  return invoke<boolean>('bundled_backend_get_auto_start');
}

/** 只修改下次客户端启动的偏好；当前内置进程仍由独立的启停按钮管理。 */
export async function setBundledBackendAutoStart(enabled: boolean): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  return invoke<boolean>('bundled_backend_set_auto_start', { enabled });
}
