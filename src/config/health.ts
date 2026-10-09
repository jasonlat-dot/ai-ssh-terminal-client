export type HealthRefreshPreferences = {
  enabled: boolean;
  normalIntervalSeconds: number;
  retryIntervalSeconds: number;
};

export const HEALTH_NORMAL_INTERVALS = [5, 10, 15, 30, 60, 120, 300] as const;
export const HEALTH_RETRY_INTERVALS = [1, 3, 5, 10, 15, 30, 60] as const;
export const DEFAULT_HEALTH_REFRESH: HealthRefreshPreferences = {
  enabled: true,
  normalIntervalSeconds: 15,
  retryIntervalSeconds: 3,
};
const HEALTH_REFRESH_STORAGE_KEY = 'agent-ssh-health-refresh-v1';

/** 仅保存本机健康检查偏好，不写入后端业务配置。 */
export function readHealthRefreshPreferences(): HealthRefreshPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HEALTH_REFRESH_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_HEALTH_REFRESH };
    const value = raw as Partial<HealthRefreshPreferences>;
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_HEALTH_REFRESH.enabled,
      normalIntervalSeconds: HEALTH_NORMAL_INTERVALS.some(interval => interval === value.normalIntervalSeconds)
        ? value.normalIntervalSeconds! : DEFAULT_HEALTH_REFRESH.normalIntervalSeconds,
      retryIntervalSeconds: HEALTH_RETRY_INTERVALS.some(interval => interval === value.retryIntervalSeconds)
        ? value.retryIntervalSeconds! : DEFAULT_HEALTH_REFRESH.retryIntervalSeconds,
    };
  } catch {
    return { ...DEFAULT_HEALTH_REFRESH };
  }
}

export function saveHealthRefreshPreferences(value: HealthRefreshPreferences): void {
  try {
    localStorage.setItem(HEALTH_REFRESH_STORAGE_KEY, JSON.stringify(value));
  } catch {
    throw new Error('无法保存刷新设置，请检查客户端存储权限。');
  }
}
