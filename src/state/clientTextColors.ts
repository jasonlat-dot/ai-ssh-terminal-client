/** 普通界面文字偏好独立于壁纸、后端和终端主题，只保存经过校验的 HEX。 */
export type TextColorTheme = 'light' | 'dark';
export type TextColorRole = 'primary' | 'secondary';
export type TextColorPalette = Record<TextColorRole, string | null>;
export type ClientTextColors = { palettes: Record<TextColorTheme, TextColorPalette>; error: string | null };
export const TEXT_COLORS_KEY = 'agent-ssh-ui-text-colors-v1';
export const DEFAULT_TEXT_COLORS = {
  light: { primary: '#25364c', secondary: '#65748a' },
  dark: { primary: '#dce8f6', secondary: '#aec0d4' },
};

/** 不接受 CSS 函数、透明色或任意样式片段，防止非法值污染界面。 */
export function normalizeTextColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(hex)) return hex;
  return /^#[\da-f]{3}$/.test(hex) ? `#${[...hex.slice(1)].map(char => char + char).join('')}` : null;
}
function readPalettes(): ClientTextColors['palettes'] {
  const result: ClientTextColors['palettes'] = { light: { primary: null, secondary: null }, dark: { primary: null, secondary: null } };
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_COLORS_KEY) ?? 'null');
    if (saved?.version !== 1) return result;
    for (const theme of ['light', 'dark'] as const) {
      for (const role of ['primary', 'secondary'] as const) result[theme][role] = normalizeTextColor(saved.palettes?.[theme]?.[role]);
    }
  } catch { /* 损坏或不可访问的偏好回退主题默认，不覆盖存储中的原数据。 */ }
  return result;
}
type TextColorStore = { snapshot: ClientTextColors; subscribers: Set<() => void> };
// 热更新时旧根节点订阅与新设置组件仍共用同一快照，避免界面颜色与控件分裂。
const colorsGlobal = globalThis as typeof globalThis & { __agentSshTextColorsV1?: TextColorStore };
const store = colorsGlobal.__agentSshTextColorsV1 ??= { snapshot: { palettes: readPalettes(), error: null }, subscribers: new Set() };
export const readClientTextColors = () => store.snapshot;
export function subscribeClientTextColors(listener: () => void) {
  store.subscribers.add(listener);
  return () => { store.subscribers.delete(listener); };
}
function publish(snapshot: ClientTextColors) {
  store.snapshot = snapshot;
  store.subscribers.forEach(listener => listener());
}
function savePalette(theme: TextColorTheme, palette: TextColorPalette): boolean {
  const palettes = { ...store.snapshot.palettes, [theme]: palette };
  try {
    // 先持久化成功再发布，失败时保持原配色，不显示虚假的自动保存成功。
    localStorage.setItem(TEXT_COLORS_KEY, JSON.stringify({ version: 1, palettes }));
    publish({ palettes, error: null });
    return true;
  } catch {
    publish({ ...store.snapshot, error: '无法保存文字颜色，已保留原配色。请检查客户端存储权限或空间。' });
    return false;
  }
}
export function setClientTextColor(theme: TextColorTheme, role: TextColorRole, value: string): boolean {
  const color = normalizeTextColor(value);
  if (!color) {
    publish({ ...store.snapshot, error: '请输入有效的 HEX 颜色，例如 #25364C。' });
    return false;
  }
  return savePalette(theme, { ...store.snapshot.palettes[theme], [role]: color });
}
/** 只清除当前浅/深色主题的覆盖，另一主题和所有壁纸偏好保持不变。 */
export function resetClientTextColors(theme: TextColorTheme): boolean {
  return savePalette(theme, { primary: null, secondary: null });
}
export function reloadClientTextColors() { publish({ palettes: readPalettes(), error: null }); }

/** 只更新专用变量，不修改 data-theme/data-wallpaper，不触发终端主题重绘。 */
export function applyClientTextColors(root: HTMLElement, snapshot = readClientTextColors()) {
  const palette = snapshot.palettes[root.dataset.theme === 'dark' ? 'dark' : 'light'];
  for (const role of ['primary', 'secondary'] as const) {
    const color = palette[role];
    root.dataset[role === 'primary' ? 'clientTextPrimary' : 'clientTextSecondary'] = color ? 'true' : 'false';
    if (color) root.style.setProperty(`--client-text-${role}`, color);
    else root.style.removeProperty(`--client-text-${role}`);
  }
}
