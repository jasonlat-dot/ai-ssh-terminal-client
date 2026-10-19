import { useErrorToast } from '../state/useToastError';
import { useEffect, useState } from 'react';
import { DEFAULT_TYPOGRAPHY, normalizeFontFamily, normalizeFontWeight, readClientTypography, resetClientTypography, setClientFontFamily,
  setClientFontWeight, UI_FONT_FAMILIES } from '../state/clientTypography';
import { useClientTypography } from '../state/useClientTypography';
import { Select } from './Select';
import { AccentIcon, Badge, Icon } from './Ui';
import { notify } from '../state/notifications';

const fontOptions = [
  { value: '', label: '跟随默认字体' },
  ...UI_FONT_FAMILIES.map(name => ({ value: name, label: name === 'Noto Sans SC' ? `${name}（可变字重）` : name })),
  { value: 'custom', label: '自定义本机字体…' },
];

function WeightControl({ role, value }: { role: 'normalWeight' | 'boldWeight'; value: number | null }) {
  const current = value ?? DEFAULT_TYPOGRAPHY[role];
  const [draft, setDraft] = useState(String(current)), [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(current)); setInvalid(false); }, [current]);
  function commit(text: string) {
    const weight = text.trim() ? normalizeFontWeight(Number(text)) : null;
    setInvalid(weight === null);
    if (weight === null) { notify('请输入 100–1000 的整数。', 'error'); return; }
    if (weight === value) return;
    if (setClientFontWeight(role, weight)) notify('字体粗细已自动保存。', 'success');
    else { setDraft(String(current)); notify(readClientTypography().error ?? '字体粗细保存失败。', 'error'); }
  }
  const label = role === 'normalWeight' ? '正常字体粗细' : '粗体字体粗细';
  return <div className="appearance-typography-row">
    <label htmlFor={`ui-${role}`} className="appearance-control-label"><Icon name="type" size={14} />{label}</label>
    <input id={`ui-${role}`} type="number" className="settings-control" min={100} max={1000} step={1}
      value={draft} aria-invalid={invalid} aria-describedby="ui-font-help"
      onChange={event => { const next = event.target.value; setDraft(next); setInvalid(false);
        if (next && normalizeFontWeight(Number(next)) !== null) commit(next); }}
      onBlur={() => { if (draft !== String(current)) commit(draft); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(draft); } }} />
  </div>;
}

export function TypographySettings() {
  const settings = useClientTypography();
  useErrorToast(settings.error);
  const known = settings.family !== null && UI_FONT_FAMILIES.some(name => name === settings.family);
  const [custom, setCustom] = useState(!!settings.family && !known);
  const [draft, setDraft] = useState(settings.family ?? '');
  const [invalid, setInvalid] = useState(false);
  const [resetGeneration, setResetGeneration] = useState(0);
  useEffect(() => {
    setDraft(settings.family ?? ''); setInvalid(false);
    setCustom(!!settings.family && !UI_FONT_FAMILIES.some(name => name === settings.family));
  }, [settings.family]);
  const commitFamily = () => {
    const family = normalizeFontFamily(draft); setInvalid(!family);
    if (!family) { notify('请输入单个本机字体名称，不支持路径或 CSS 片段。', 'error'); return; }
    if (family === settings.family) return;
    if (setClientFontFamily(family)) notify('界面字体已自动保存。', 'success');
    else { setDraft(settings.family ?? ''); notify(readClientTypography().error ?? '界面字体保存失败。', 'error'); }
  };
  return <section className="appearance-typography" aria-labelledby="appearance-typography-title">
    <div className="appearance-text-colors-heading appearance-typography-heading"><strong id="appearance-typography-title" className="appearance-section-title"><AccentIcon icon="type" tone="violet" size={17} />界面字体</strong>
      <Select id="ui-font-family" label="界面字体" className="settings-control" value={custom ? 'custom' : settings.family ?? ''}
        options={fontOptions} onChange={next => {
          if (next === 'custom') { setCustom(true); setDraft(''); setInvalid(false); }
          else if (setClientFontFamily(next || null)) { setCustom(false); setInvalid(false); notify('界面字体已自动保存。', 'success'); }
          else notify(readClientTypography().error ?? '界面字体保存失败。', 'error');
        }} />
      <Badge tone="cyan" icon="check">自动保存</Badge>
    </div>
    {custom && <div className="appearance-custom-font">
      <label className="visually-hidden" htmlFor="ui-custom-font">自定义本机字体名称</label>
      <input id="ui-custom-font" className="settings-control" value={draft} maxLength={80} placeholder="输入已安装的字体名称"
        aria-invalid={invalid} aria-describedby="ui-font-help" onChange={event => { setDraft(event.target.value); setInvalid(false); }}
        onBlur={commitFamily} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFamily(); } }} />
    </div>}
    <WeightControl key={`normal-${resetGeneration}`} role="normalWeight" value={settings.normalWeight} /><WeightControl key={`bold-${resetGeneration}`} role="boldWeight" value={settings.boldWeight} />
    <p id="ui-font-help" className="appearance-help">字重 100–1000；字体未安装或不支持该字重时使用可用的替代效果。不改变终端、代码和公式字体。</p>
    <button type="button" className="ghost-button" disabled={!settings.family && settings.normalWeight === null && settings.boldWeight === null}
      onClick={() => { if (resetClientTypography()) { setCustom(false); setDraft(''); setInvalid(false); setResetGeneration(value => value + 1); notify('已恢复默认字体与粗细。', 'success'); } else notify(readClientTypography().error ?? '恢复字体失败。', 'error'); }}><Icon name="refresh" size={13} />恢复默认字体与粗细</button>
  </section>;
}
