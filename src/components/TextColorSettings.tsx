import { useEffect, useState } from 'react';
import { DEFAULT_TEXT_COLORS, normalizeTextColor, resetClientTextColors, setClientTextColor } from '../state/clientTextColors';
import type { TextColorRole, TextColorTheme } from '../state/clientTextColors';
import { useClientTextColors } from '../state/useClientTextColors';

function TextColorControl({ theme, role, color, custom }: { theme: TextColorTheme; role: TextColorRole; color: string; custom: boolean }) {
  const [hex, setHex] = useState(color.toUpperCase());
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setHex(color.toUpperCase()); setInvalid(false); }, [color, theme]);
  const label = role === 'primary' ? '主要文字' : '辅助文字';
  const commit = (value: string) => {
    const normalized = normalizeTextColor(value);
    setInvalid(!normalized);
    if (normalized) {
      if (setClientTextColor(theme, role, normalized)) setHex(normalized.toUpperCase());
      else setHex(color.toUpperCase());
    }
  };
  return <div className="appearance-text-color-row">
    <label htmlFor={`text-${role}-hex`}>{label}<small>{custom ? '自定义' : '主题默认'}</small></label>
    <input type="color" className="appearance-color-swatch" aria-label={`选择${label}颜色`} value={color}
      onChange={event => commit(event.target.value)} />
    <input id={`text-${role}-hex`} className="settings-control appearance-color-hex" value={hex} maxLength={7}
      aria-label={`${label} HEX`} aria-invalid={invalid} aria-describedby={invalid ? `text-${role}-error` : undefined}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="#25364C"
      onChange={event => {
        const next = event.target.value; setHex(next); setInvalid(false);
        // 输入中允许不完整的 HEX；六位有效值即时保存，三位简写在失焦时规范化。
        if (/^#[\da-f]{6}$/i.test(next)) commit(next);
      }} onBlur={() => { if (hex !== color.toUpperCase()) commit(hex); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(hex); } }} />
    {invalid && <p id={`text-${role}-error`} className="appearance-color-error" role="alert">请输入 #RGB 或 #RRGGBB。</p>}
  </div>;
}

/** 与画面选区确认保存独立，当前主题颜色即时保存；不需要重启或有壁纸才能使用。 */
export function TextColorSettings() {
  const { palettes, theme, error } = useClientTextColors();
  const palette = palettes[theme];
  const defaults = { ...DEFAULT_TEXT_COLORS[theme] };
  // 读取根主题的实际默认值，包含壁纸可读性保护；自定义变量只作用于界面容器，不污染根值。
  if (typeof document !== 'undefined' && typeof getComputedStyle !== 'undefined') {
    const styles = getComputedStyle(document.documentElement);
    defaults.primary = normalizeTextColor(styles.getPropertyValue('--theme-text-strong')) || defaults.primary;
    defaults.secondary = normalizeTextColor(styles.getPropertyValue('--theme-text-muted')) || defaults.secondary;
  }
  return <section className="appearance-text-colors" aria-labelledby="appearance-text-colors-title">
    <div className="appearance-text-colors-heading"><strong id="appearance-text-colors-title">界面文字颜色</strong>
      <span>{theme === 'dark' ? '深色主题' : '浅色主题'} · 自动保存</span></div>
    {(['primary', 'secondary'] as const).map(role => <TextColorControl key={`${theme}-${role}`} theme={theme} role={role}
      color={palette[role] || defaults[role]} custom={!!palette[role]} />)}
    <p className="appearance-help">浅色、深色分别保存。终端输出、代码高亮、状态提示和实心按钮文字保持原配色。</p>
    <button type="button" className="ghost-button" disabled={!palette.primary && !palette.secondary}
      onClick={() => resetClientTextColors(theme)}>恢复当前主题文字颜色</button>
    {error && <p className="appearance-color-error" role="alert">{error}</p>}
  </section>;
}
