export type ThemePreference = 'light' | 'dark' | 'night';
export const THEME_OPTIONS = [
  { value: 'light', label: '柔光白' },
  { value: 'dark', label: '暮雾灰' },
  { value: 'night', label: '夜幕黑' },
] as const;
export const THEME_LABELS = { light: '柔光白', dark: '暮雾灰', night: '夜幕黑' } as const;
