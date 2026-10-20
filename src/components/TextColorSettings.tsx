import { useErrorToast } from '../state/useToastError';
import { useEffect, useState } from 'react';
import { DEFAULT_TEXT_COLORS, normalizeTextColor, readClientTextColors, resetClientTextColors, setClientTextColor } from '../state/clientTextColors';
import { notify } from '../state/notifications';
import type { TextColorRole, TextColorTheme } from '../state/clientTextColors';
import { useClientTextColors } from '../state/useClientTextColors';
import { AccentIcon, Badge, Icon } from './Ui';
import { THEME_LABELS } from '../state/themes';

function TextColorControl({ theme, role, color, custom }: { theme: TextColorTheme; role: TextColorRole; color: string; custom: boolean }) {
  const [hex, setHex] = useState(color.toUpperCase());
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setHex(color.toUpperCase()); setInvalid(false); }, [color, theme]);
  const label = role === 'primary' ? '主要文字' : '辅助文字';
  const commit = (value: string) => {
    const normalized = normalizeTextColor(value);
    setInvalid(!normalized);
    if (!normalized) { notify('请输入 #RGB 或 #RRGGBB。', 'error'); return; }
    if (normalized) {
      if (normalized === color && custom) return;
      if (setClientTextColor(theme, role, normalized)) { setHex(normalized.toUpperCase()); notify('文字颜色已自动保存。', 'success'); }
      else { setHex(color.toUpperCase()); notify(readClientTextColors().error ?? '文字颜色保存失败。', 'error'); }
    }
  };
  return <div className="appearance-text-color-row">
    <label htmlFor={`text-${role}-hex`}><span className="appearance-control-label"><Icon name="type" size={14} />{label}</span><small>{custom ? '自定义' : '主题默认'}</small></label>
    <input type="color" className="appearance-color-swatch" aria-label={`选择${label}颜色`} value={color}
      onChange={event => commit(event.target.value)} />
    <input id={`text-${role}-hex`} className="settings-control appearance-color-hex" value={hex} maxLength={7}
      aria-label={`${label} HEX`} aria-invalid={invalid}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="#25364C"
      onChange={event => {
        const next = event.target.value; setHex(next); setInvalid(false);
        // 输入中允许不完整的 HEX；六位有效值即时保存，三位简写在失焦时规范化。
        if (/^#[\da-f]{6}$/i.test(next)) commit(next);
      }} onBlur={() => { if (hex !== color.toUpperCase()) commit(hex); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(hex); } }} />
  </div>;
}

/** 与画面选区确认保存独立，当前主题颜色即时保存；不需要重启或有壁纸才能使用。 */
export function TextColorSettings() {
  const { palettes, theme, error } = useClientTextColors();
  useErrorToast(error);
  const palette = palettes[theme];
  const defaults = { ...DEFAULT_TEXT_COLORS[theme] };
  // 读取根主题的实际默认值，包含壁纸可读性保护；自定义变量只作用于界面容器，不污染根值。
  if (typeof document !== 'undefined' && typeof getComputedStyle !== 'undefined') {
    const styles = getComputedStyle(document.documentElement);
    defaults.primary = normalizeTextColor(styles.getPropertyValue('--theme-text-strong')) || defaults.primary;
    defaults.secondary = normalizeTextColor(styles.getPropertyValue('--theme-text-muted')) || defaults.secondary;
  }
  return <section className="appearance-text-colors" aria-labelledby="appearance-text-colors-title">
    <div className="appearance-text-colors-heading"><strong id="appearance-text-colors-title" className="appearance-section-title"><AccentIcon icon="palette" tone="blue" size={17} />界面文字颜色</strong>
      <Badge tone="cyan">{THEME_LABELS[theme]} · 自动保存</Badge></div>
    {(['primary', 'secondary'] as const).map(role => <TextColorControl key={`${theme}-${role}`} theme={theme} role={role}
      color={palette[role] || defaults[role]} custom={!!palette[role]} />)}
    <p className="appearance-help">柔光白、暮雾灰、夜幕黑分别保存。终端输出、代码高亮、状态提示和实心按钮文字保持原配色。</p>
    <button type="button" className="ghost-button" disabled={!palette.primary && !palette.secondary}
      onClick={() => { if (resetClientTextColors(theme)) notify('已恢复当前主题的默认文字颜色。', 'success'); else notify(readClientTextColors().error ?? '恢复文字颜色失败。', 'error'); }}><Icon name="refresh" size={13} />恢复当前主题文字颜色</button>
  </section>;
}
