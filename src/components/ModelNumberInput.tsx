import { Select } from './Select';
import './ModelNumberInput.css';

type NumberPreset = { value: number | ''; short: string; label: string; description: string };
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
const safetyPresets = [0, 128, 256, 512, 1024, 2048, 4096, 8192].map(value => ({
  value, short: value >= 1024 ? `${value / 1024}Ki` : String(value), label: `${value.toLocaleString('en-US')} tokens`, description: value === 8192 ? '默认' : '安全预留',
}));
const compactPresets = [50, 60, 70, 75, 80, 85, 90, 95].map(value => ({
  value, short: `${value}%`, label: `${value}%`, description: value === 75 ? '默认' : '自动整理触发比例',
}));
const temperaturePresets: NumberPreset[] = [
  { value: '', short: '默认', label: '不发送（默认）', description: '由供应商决定' },
  ...[0, 0.2, 0.5, 0.7, 1, 1.5, 2].map(value => ({ value, short: String(value), label: String(value), description: 'Temperature' })),
];
const settings = {
  context: {presets:contextPresets,min:256,max:16777216},
  output: {presets:outputPresets,min:1,max:undefined},
  timeout: {presets:timeoutPresets,min:1,max:600},
  response: {presets:responsePresets,min:1024,max:8388608},
  safety: {presets:safetyPresets,min:0,max:16777216},
  compact: {presets:compactPresets,min:1,max:99},
  temperature: {presets:temperaturePresets,min:0,max:2},
  storage: {presets:[256,512,1024,2048,5120,10240,51200,102400].map(value=>({value,short:value>=1024?`${value/1024} GiB`:`${value} MiB`,label:value>=1024?`${value/1024} GiB`:`${value} MiB`,description:`${value} MiB`})),min:20,max:102400},
  retention: {presets:[0,7,30,90,180,365].map(value=>({value,short:value===0?'长期':`${value} 天`,label:value===0?'长期保留':`${value} 天`,description:value===0?'不自动删除':'自动清理过期附件'})),min:0,max:3650},
};

type Props = { id: string; label: string; disabled: boolean } & (
  { kind: 'temperature'; value: number | null; onChange: (value: number | null) => void }
  | { kind: Exclude<keyof typeof settings, 'temperature'>; value: number; onChange: (value: number) => void }
);
/** 精确数值始终可编辑；预设只快捷填写数值，不改变实际单位或限制。 */
export function ModelNumberInput(props: Props) {
  const { id, label, value, kind, disabled } = props;
  const {presets,min,max} = settings[kind];
  const selectedValue = value ?? '';
  const selected = presets.find(option => option.value === selectedValue);
  const options = selected ? presets : [
    { value: selectedValue, short: '自定义', label: '自定义', description: value?.toLocaleString('en-US') ?? '不发送' },
    ...presets,
  ];
  const change = (value: number | string) => {
    if (props.kind === 'temperature') props.onChange(value === '' ? null : Number(value));
    else props.onChange(Number(value));
  };
  return <div className={`model-token-input${disabled ? ' is-disabled' : ''}`}>
    <input id={id} className="settings-control model-token-value" type="number" inputMode={kind === 'temperature' ? 'decimal' : 'numeric'}
      min={min} max={max}
      step={kind === 'temperature' ? 0.1 : 1} value={selectedValue} placeholder={kind === 'temperature' ? '不发送' : undefined} disabled={disabled} onChange={event => change(event.target.value)} />
    <Select id={`${id}-preset`} label={`${label}常用档位`} className="model-token-presets"
      value={selectedValue} displayValue={selected?.short ?? '自定义'} options={options}
      menuMinWidth={264} menuAlign="end" menuClassName="model-token-menu" disabled={disabled} onChange={change} />
  </div>;
}
