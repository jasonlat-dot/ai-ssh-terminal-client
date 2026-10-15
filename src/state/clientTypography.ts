/** 普通界面的字体和字重独立保存，不修改终端/代码字体和后端配置。 */
export type ClientTypography = { family: string | null; normalWeight: number | null; boldWeight: number | null; error: string | null };
export const TYPOGRAPHY_KEY = 'agent-ssh-ui-typography-v1';
export const DEFAULT_TYPOGRAPHY = { normalWeight: 400, boldWeight: 600 };
export const UI_FONT_FAMILIES = ['Noto Sans SC', 'Noto Serif SC', 'Segoe UI Variable', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', 'Arial', 'Consolas', 'PingFang SC'] as const;
export function normalizeFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  // 只接受单个本机字体名，不接受 CSS 样式片段、URL 或字体文件路径。
  return name.length > 0 && name.length <= 80 && /^[\p{L}\p{N} ._-]+$/u.test(name) ? name : null;
}
export function normalizeFontWeight(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 1000 ? value : null;
}
function readPreferences(): ClientTypography {
  const defaults: ClientTypography = { family: null, normalWeight: null, boldWeight: null, error: null };
  try {
    const saved = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) ?? 'null');
    if (saved?.version !== 1) return defaults;
    return { family: normalizeFontFamily(saved.family), normalWeight: normalizeFontWeight(saved.normalWeight),
      boldWeight: normalizeFontWeight(saved.boldWeight), error: null };
  } catch { return defaults; }
}
type TypographyStore = { snapshot: ClientTypography; subscribers: Set<() => void> };
const shared = globalThis as typeof globalThis & { __agentSshTypographyV1?: TypographyStore };
const store = shared.__agentSshTypographyV1 ??= { snapshot: readPreferences(), subscribers: new Set() };
export const readClientTypography = () => store.snapshot;
export function subscribeClientTypography(callback: () => void) { store.subscribers.add(callback); return () => { store.subscribers.delete(callback); }; }
function publish(snapshot: ClientTypography) { store.snapshot = snapshot; store.subscribers.forEach(callback => callback()); }
function save(patch: Partial<ClientTypography>) {
  const next = { ...store.snapshot, ...patch, error: null };
  try {
    const { error: _error, ...preferences } = next;
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ version: 1, ...preferences }));
    publish(next); return true;
  } catch { publish({ ...store.snapshot, error: '字体设置保存失败，已保留原设置。请检查客户端存储权限或空间。' }); return false; }
}
export function setClientFontFamily(value: string | null) {
  const family = value === null ? null : normalizeFontFamily(value);
  if (value !== null && !family) { publish({ ...store.snapshot, error: '请输入有效的本机字体名称，不支持路径或 CSS 片段。' }); return false; }
  return save({ family });
}
export function setClientFontWeight(role: 'normalWeight' | 'boldWeight', value: number | null) {
  const weight = value === null ? null : normalizeFontWeight(value);
  if (value !== null && weight === null) { publish({ ...store.snapshot, error: '字体粗细须为 100–1000 的整数。' }); return false; }
  return save({ [role]: weight });
}
export const resetClientTypography = () => save({ family: null, normalWeight: null, boldWeight: null });
export const reloadClientTypography = () => publish(readPreferences());
export function applyClientTypography(root: HTMLElement, settings = readClientTypography()) {
  const variables = {
    '--client-ui-font': settings.family ? JSON.stringify(settings.family) + ', var(--client-original-font)' : null,
    '--client-ui-weight-normal': settings.normalWeight === null ? null : String(settings.normalWeight),
    '--client-ui-weight-bold': settings.boldWeight === null ? null : String(settings.boldWeight),
  };
  root.dataset.clientFont = settings.family ? 'true' : 'false';
  root.dataset.clientWeightNormal = settings.normalWeight === null ? 'false' : 'true';
  root.dataset.clientWeightBold = settings.boldWeight === null ? 'false' : 'true';
  for (const [name, value] of Object.entries(variables)) {
    if (value === null) root.style.removeProperty(name); else root.style.setProperty(name, value);
  }
}
