import { Select } from './Select';

type TokenPreset = { value: number; short: string; label: string; description: string };
const preset = (short: string, value: number): TokenPreset => ({
  value, short, label: `${short} · ${short.includes('i') ? '1024 制' : '1000 制'}`,
  description: value.toLocaleString('en-US'),
});

const contextPresets = [
  preset('8Ki', 8192), preset('16Ki', 16384), preset('32Ki', 32768), preset('64Ki', 65536),
  preset('128K', 128000), preset('128Ki', 131072), preset('200K', 200000),
  preset('256K', 256000), preset('256Ki', 262144), preset('400K', 400000),
  preset('1M', 1000000), preset('1Mi', 1048576), preset('1.05M', 1050000),
];
const outputPresets = [
  preset('1Ki', 1024), preset('2Ki', 2048), preset('4Ki', 4096), preset('8Ki', 8192),
  preset('16Ki', 16384), preset('32Ki', 32768), preset('64Ki', 65536),
  preset('128K', 128000), preset('128Ki', 131072),
];

/** 精确数值始终可编辑；档位仅提供快捷填写，不代表模型支持该容量。 */
export function TokenBudgetInput({ id, label, value, kind, disabled, onChange }: {
  id: string;
  label: string;
  value: number;
  kind: 'context' | 'output';
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const presets = kind === 'context' ? contextPresets : outputPresets;
  const selected = presets.find(option => option.value === value);
  const options = selected ? presets : [
    { value, short: '自定义', label: '自定义', description: value.toLocaleString('en-US') },
    ...presets,
  ];
  return <div className={`model-token-input${disabled ? ' is-disabled' : ''}`}>
    <input id={id} className="settings-control model-token-value" type="number" inputMode="numeric"
      min={kind === 'context' ? 256 : 1} max={kind === 'context' ? 16777216 : undefined}
      step={1} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))} />
    <Select id={`${id}-preset`} label={`${label}常用档位`} className="model-token-presets"
      value={value} displayValue={selected?.short ?? '自定义'} options={options}
      menuMinWidth={264} menuAlign="end" menuClassName="model-token-menu" disabled={disabled} onChange={onChange} />
  </div>;
}
