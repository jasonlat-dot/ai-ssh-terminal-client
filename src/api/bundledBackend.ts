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

/**
 * 订阅内置服务状态，替代前端的固定间隔轮询。
 *
 * @param onStatus 首次快照或新版本事件的接收函数；业务健康检查仍由 /api/health 完成。
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

/** 只修改下次客户端启动的偏好；当前内置进程仍由独立的启停按钮管理。 */
export async function setBundledBackendAutoStart(enabled: boolean): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  return invoke<boolean>('bundled_backend_set_auto_start', { enabled });
}
