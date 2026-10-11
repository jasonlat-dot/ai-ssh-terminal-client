import { useEffect, useState } from 'react';
import { DEFAULT_TYPOGRAPHY, normalizeFontFamily, normalizeFontWeight, resetClientTypography, setClientFontFamily,
  setClientFontWeight, UI_FONT_FAMILIES } from '../state/clientTypography';
import { useClientTypography } from '../state/useClientTypography';

function WeightControl({ role, value }: { role: 'normalWeight' | 'boldWeight'; value: number | null }) {
  const current = value ?? DEFAULT_TYPOGRAPHY[role];
  const [draft, setDraft] = useState(String(current)), [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(current)); setInvalid(false); }, [current]);
  function commit(text: string) {
    const weight = text.trim() ? normalizeFontWeight(Number(text)) : null;
    setInvalid(weight === null);
    if (weight !== null && !setClientFontWeight(role, weight)) setDraft(String(current));
  }
  const label = role === 'normalWeight' ? '正常字体粗细' : '粗体字体粗细';
  return <div className="appearance-typography-row">
    <label htmlFor={`ui-${role}`}>{label}</label>
    <input id={`ui-${role}`} type="number" className="settings-control" min={100} max={1000} step={1}
      value={draft} aria-invalid={invalid} aria-describedby={invalid ? `ui-${role}-error` : 'ui-font-help'}
      onChange={event => { const next = event.target.value; setDraft(next); setInvalid(false);
        if (next && normalizeFontWeight(Number(next)) !== null) commit(next); }}
      onBlur={() => { if (draft !== String(current)) commit(draft); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(draft); } }} />
    {invalid && <p id={`ui-${role}-error`} className="appearance-color-error" role="alert">请输入 100–1000 的整数。</p>}
  </div>;
}

export function TypographySettings() {
  const settings = useClientTypography();
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
    if (family && !setClientFontFamily(family)) setDraft(settings.family ?? '');
  };
  return <section className="appearance-typography" aria-labelledby="appearance-typography-title">
    <div className="appearance-text-colors-heading"><strong id="appearance-typography-title">界面字体</strong><span>实时生效 · 自动保存</span></div>
    <div className="appearance-typography-row"><label htmlFor="ui-font-family">字体</label>
      <select id="ui-font-family" className="settings-control" value={custom ? 'custom' : settings.family ?? ''}
        onChange={event => {
          const next = event.target.value;
          if (next === 'custom') { setCustom(true); setDraft(''); setInvalid(false); }
          else if (setClientFontFamily(next || null)) { setCustom(false); setInvalid(false); }
        }}><option value="">跟随默认字体</option>{UI_FONT_FAMILIES.map(name => <option key={name} value={name}>{name}</option>)}
        <option value="custom">自定义本机字体…</option></select>
    </div>
    {custom && <div className="appearance-custom-font">
      <label className="visually-hidden" htmlFor="ui-custom-font">自定义本机字体名称</label>
      <input id="ui-custom-font" className="settings-control" value={draft} maxLength={80} placeholder="输入已安装的字体名称"
        aria-invalid={invalid} aria-describedby="ui-font-help" onChange={event => { setDraft(event.target.value); setInvalid(false); }}
        onBlur={commitFamily} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFamily(); } }} />
      {invalid && <p className="appearance-color-error" role="alert">请输入单个本机字体名称，不支持路径或 CSS 片段。</p>}
    </div>}
    <WeightControl key={`normal-${resetGeneration}`} role="normalWeight" value={settings.normalWeight} /><WeightControl key={`bold-${resetGeneration}`} role="boldWeight" value={settings.boldWeight} />
    <p id="ui-font-help" className="appearance-help">字重 100–1000；字体未安装或不支持该字重时使用可用的替代效果。不改变终端、代码和公式字体。</p>
    <button type="button" className="ghost-button" disabled={!settings.family && settings.normalWeight === null && settings.boldWeight === null}
      onClick={() => { if (resetClientTypography()) { setCustom(false); setDraft(''); setInvalid(false); setResetGeneration(value => value + 1); } }}>恢复默认字体与粗细</button>
    {settings.error && <p className="appearance-color-error" role="alert">{settings.error}</p>}
  </section>;
}
