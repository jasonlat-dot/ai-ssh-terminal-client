import { Select } from './Select';
import './ModelNumberInput.css';

type NumberPreset = { value: number; short: string; label: string; description: string };
const preset = (short: string, value: number): NumberPreset => ({
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

const timeoutPresets = [15, 30, 60, 120, 180, 300, 600].map(value => ({
  value, short: `${value}s`, label: `${value} 秒`,
  description: value < 60 ? `${value} 秒` : `${value / 60} 分钟`,
}));
const responsePresets = [
  {short:'64 KiB',value:65536}, {short:'128 KiB',value:131072}, {short:'256 KiB',value:262144},
  {short:'512 KiB',value:524288}, {short:'1 MiB',value:1048576},
  {short:'2 MiB',value:2097152}, {short:'4 MiB',value:4194304},
  {short:'8 MiB',value:8388608},
].map(option => ({...option,label:option.short,description:`${option.value.toLocaleString('en-US')} bytes`}));
const settings = {
  context: {presets:contextPresets,min:256,max:16777216},
  output: {presets:outputPresets,min:1,max:undefined},
  timeout: {presets:timeoutPresets,min:1,max:600},
  response: {presets:responsePresets,min:1024,max:8388608},
};

/** 精确数值始终可编辑；预设只快捷填写数值，不改变实际单位或限制。 */
export function ModelNumberInput({ id, label, value, kind, disabled, onChange }: {
  id: string;
  label: string;
  value: number;
  kind: keyof typeof settings;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const {presets,min,max} = settings[kind];
  const selected = presets.find(option => option.value === value);
  const options = selected ? presets : [
    { value, short: '自定义', label: '自定义', description: value.toLocaleString('en-US') },
    ...presets,
  ];
  return <div className={`model-token-input${disabled ? ' is-disabled' : ''}`}>
    <input id={id} className="settings-control model-token-value" type="number" inputMode="numeric"
      min={min} max={max}
      step={1} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))} />
    <Select id={`${id}-preset`} label={`${label}常用档位`} className="model-token-presets"
      value={value} displayValue={selected?.short ?? '自定义'} options={options}
      menuMinWidth={264} menuAlign="end" menuClassName="model-token-menu" disabled={disabled} onChange={onChange} />
  </div>;
}
