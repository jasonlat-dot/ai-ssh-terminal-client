import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig,
  readBundledBackendAutoStart,
  readBundledBackendStatus,
  restartBundledBackend,
  stopBundledBackend,
  saveBundledBackendConfig,
  setBundledBackendAutoStart,
  type BundledBackendConfig,
  type BundledBackendConfigValue,
  type BundledBackendStatus,
} from '../api/bundledBackend';
import { probeBackendHealth, type BackendHealthSnapshot } from '../api/health';
import { normalizeBackendUrl } from '../config/backend';
import { isTauriRuntime } from '../state/runtime';
import { Icon, Toggle } from './Ui';
import './BackendSettingsDialog.css';

/* ============================================================================
 * 类型定义
 * ========================================================================== */

type BackendSettingsDialogProps = {
  currentUrl: string;
  required?: boolean;
  onClose: () => void;
  onSave: (url: string) => void;
};

type SettingsSection = 'general' | 'model' | 'proxy' | 'storage';
type ConfigValues = Record<string, string>;
type FieldType = 'text' | 'password' | 'number' | 'textarea' | 'choice' | 'toggle';

/**
 * kind 用于指定自定义渲染器。type 仍然保留基础 input 控件。
 * - 'reasoning'：推理强度专属网格
 * - 'port'：后端端口，支持常用端口 preset
 * - 'path-preset'：路径字段，支持预设
 * - 'timeout'：超时字段，支持秒/分级预设
 * - 'bucket'：MinIO 桶名，提供命名规范提示
 * - 'host-list'：非代理地址列表
 */
type FieldKind = 'reasoning' | 'port' | 'path-preset' | 'timeout' | 'bucket' | 'host-list';

type FieldDefinition = {
  key: string;
  label: string;
  help?: string;
  type?: FieldType;
  kind?: FieldKind;
  placeholder?: string;
  options?: { value: string; label: string }[];
  wide?: boolean;
  /** 用于右侧 chip 显示 */
  badge?: string;
  /** 内置 ID，标识与某个抽象能力关联 */
  bind?: string;
  /** 当 kind === 'path-preset' 时指定分组 key（与 openAiPathPresets 关联） */
  pathGroup?: string;
};

type SectionDefinition = {
  id: SettingsSection;
  label: string;
  caption: string;
  icon: 'settings' | 'bot' | 'network' | 'database';
  /** 该 tab 涉及的配置 key，用于"按 tab 保存"和 dirty 判断 */
  keys: readonly string[];
  /** 吸底保存条的目标按钮文案，例如"保存连接配置" */
  saveLabel: string;
  /** 吸底保存条右侧的说明文字 */
  saveHint: string;
};

/* ============================================================================
 * 静态元数据：所有字段都声明式定义
 * ========================================================================== */

/** 按 tab 划分。每个 tab 仅在保存时把对应 keys 写入 YAML，未提交的字段保留原值。 */
const GENERAL_KEYS = ['serverPort', 'dataDirectory'] as const;
const MODEL_KEYS = [
  'aiBaseUrl', 'aiApiKey', 'aiCompletionsPath', 'aiEmbeddingsPath',
  'aiModelName', 'aiReasoningEffort', 'aiSupportedMediaTypes',
  'aiProxyEnabled', 'aiProxyHost', 'aiProxyPort', 'aiNonProxyHosts',
] as const;
const PROXY_KEYS = [
  'aiProxyEnabled', 'aiProxyHost', 'aiProxyPort', 'aiNonProxyHosts',
  'sshProxyEnabled', 'sshProxyHost', 'sshProxyPort',
  'sshProxyUsername', 'sshProxyPassword',
] as const;
const STORAGE_KEYS = [
  'fileStorageDefaultId', 'localStorageId', 'minioStorageId',
  'localStorageEnabled', 'localRootDirectory', 'localPublicBaseUrl', 'localSigningSecret',
  'minioEnabled', 'minioEndpoint', 'minioPublicEndpoint',
  'minioAccessKey', 'minioSecretKey', 'minioBucket', 'minioRegion',
  'minioConnectTimeout', 'minioReadTimeout', 'minioWriteTimeout', 'minioCallTimeout',
] as const;

/** Rust 侧保留的内部 ID，前端只展示、不写回。 */
const RESERVED_KEYS = new Set(['localStorageId', 'minioStorageId', 'localRootDirectory']);

const sectionItems: SectionDefinition[] = [
  { id: 'general', label: '连接', caption: '地址 · 端口 · 数据目录', icon: 'settings',
    keys: GENERAL_KEYS,
    saveLabel: '保存连接配置', saveHint: '保存到 YAML，不会重启后端；正在运行的会话不受影响。' },
  { id: 'model', label: '模型', caption: '渠道 · 协议 · 附件', icon: 'bot',
    keys: MODEL_KEYS,
    saveLabel: '保存模型配置', saveHint: '保存到 YAML，不会重启后端；模型服务无需重启即可读取新配置。' },
  { id: 'proxy', label: '代理', caption: 'AI 与 SSH HTTP 代理', icon: 'network',
    keys: PROXY_KEYS,
    saveLabel: '保存代理配置', saveHint: '保存到 YAML，不会重启后端；新连接会使用新代理规则。' },
  { id: 'storage', label: '存储', caption: '本地与对象存储', icon: 'database',
    keys: STORAGE_KEYS,
    saveLabel: '保存存储配置', saveHint: '保存到 YAML，不会重启后端；新上传会按新存储设置生效。' },
];

const generalFields: FieldDefinition[] = [
  { key: 'serverPort', label: '后端运行端口', kind: 'port', placeholder: '8888', badge: 'TCP' },
  { key: 'dataDirectory', label: '统一数据目录', placeholder: '/var/lib/ai-ssh-terminal', wide: true,
    help: 'SQLite、上传文件、运行日志都会派生在该目录下。切换前请先停止后端。' },
];

const modelFields: FieldDefinition[] = [
  { key: 'aiBaseUrl', label: '模型服务地址', placeholder: 'http://127.0.0.1:8777/', wide: true,
    help: 'OpenAI 兼容服务的根地址，不要附加 /v1/chat/completions。', badge: 'BASE URL' },
  { key: 'aiApiKey', label: 'API Key', type: 'password', wide: true,
    help: '密钥不会回显。留空表示保留现有值。' },
  { key: 'aiCompletionsPath', label: '对话接口路径', kind: 'path-preset',
    pathGroup: 'aiCompletionsPath', placeholder: 'v1/chat/completions',
    help: 'OpenAI 兼容服务通常无需修改。' },
  { key: 'aiEmbeddingsPath', label: '向量接口路径', kind: 'path-preset',
    pathGroup: 'aiEmbeddingsPath', placeholder: 'v1/embeddings',
    help: '只有服务商使用不同路径时才修改。' },
  { key: 'aiModelName', label: '模型名称', placeholder: 'gpt-5.5', badge: 'MODEL' },
  { key: 'aiReasoningEffort', label: '推理强度', kind: 'reasoning', wide: true,
    help: '越高通常思考时间越长，也可能消耗更多额度。' },
];

const aiProxyFields: FieldDefinition[] = [
  { key: 'aiProxyHost', label: '代理主机', placeholder: 'http://proxy.example.com', badge: 'HOST' },
  { key: 'aiProxyPort', label: '代理端口', type: 'number', placeholder: '7890', badge: 'TCP' },
  { key: 'aiNonProxyHosts', label: '不使用代理的地址', kind: 'host-list', wide: true,
    help: '每行填写一个地址或通配模式，命中后请求绕过代理。' },
];

/** 推理强度档位：中英文 + 描述 + 等级（0-7），UI 用网格卡片渲染。 */
const reasoningEffortLevels: { value: string; label: string; english: string; description: string; level: number }[] = [
  { value: 'none',    label: '关闭', english: 'None',       description: '不启用推理，按普通模型返回',         level: 0 },
  { value: 'minimal', label: '极低', english: 'Minimal',    description: '几乎无额外思考，响应最快',           level: 1 },
  { value: 'low',     label: '低',   english: 'Low',        description: '略加推理，适合简单问答',             level: 2 },
  { value: 'medium',  label: '中',   english: 'Medium',     description: '默认档位，多数任务平衡',             level: 3 },
  { value: 'high',    label: '高',   english: 'High',       description: '深入思考，复杂任务推荐',             level: 4 },
  { value: 'xhigh',   label: '很高', english: 'Extra High', description: '更强推理，适合长链路分析',           level: 5 },
  { value: 'max',     label: '最高', english: 'Maximum',    description: '几乎全量推理，耗时显著增加',         level: 6 },
  { value: 'ultra',   label: '极致', english: 'Ultra',      description: '可能消耗大量 token，仅用于棘手场景', level: 7 },
];

/** 非代理地址快速示例。 */
const nonProxyPresets = ['localhost', '127.0.0.1', '10.*', '192.168.*', '*.local'];

/** OpenAI 兼容服务常用路径快选。 */
const openAiPathPresets: Record<string, { label: string; english: string; path: string }[]> = {
  aiCompletionsPath: [
    { label: 'OpenAI 标准', english: 'v1/chat/completions',     path: 'v1/chat/completions' },
    { label: 'Azure OpenAI', english: 'openai/deployments',       path: 'openai/deployments/{model}/chat/completions?api-version=...' },
    { label: '通义 / 智谱', english: 'compatible-mode',          path: 'v1/chat/completions' },
  ],
  aiEmbeddingsPath: [
    { label: 'OpenAI 标准', english: 'v1/embeddings',            path: 'v1/embeddings' },
    { label: 'Azure OpenAI', english: 'openai/deployments',       path: 'openai/deployments/{model}/embeddings?api-version=...' },
  ],
};

/** 后端常用端口快选。 */
const serverPortPresets = [
  { port: 8888, note: '默认' },
  { port: 8080, note: 'Spring' },
  { port: 7777, note: '备用' },
  { port: 9000, note: '开发' },
  { port: 8880, note: '备选默认' },
];

/** 超时快选：4 档秒/分级。 */
const timeoutPresets: Record<string, { value: string; label: string; english: string; description: string }[]> = {
  minioConnectTimeout: [
    { value: '3s',  label: '快速', english: '3s',  description: '网络较差时可能失败' },
    { value: '5s',  label: '标准', english: '5s',  description: '推荐默认值' },
    { value: '10s', label: '宽松', english: '10s', description: '适合跨区域访问' },
    { value: '30s', label: '极宽', english: '30s', description: '仅用于不可靠链路' },
  ],
  minioReadTimeout: [
    { value: '15s', label: '快速', english: '15s', description: '适合小文件' },
    { value: '30s', label: '标准', english: '30s', description: '推荐默认值' },
    { value: '1m',  label: '宽松', english: '1m',  description: '适合大文件' },
    { value: '2m',  label: '极宽', english: '2m',  description: '仅用于慢速链路' },
  ],
  minioWriteTimeout: [
    { value: '30s', label: '快速', english: '30s', description: '小文件上传' },
    { value: '60s', label: '标准', english: '60s', description: '推荐默认值' },
    { value: '2m',  label: '宽松', english: '2m',  description: '适合大文件上传' },
    { value: '5m',  label: '极宽', english: '5m',  description: '超大文件场景' },
  ],
  minioCallTimeout: [
    { value: '1m',  label: '快速', english: '1m',  description: '短操作' },
    { value: '2m',  label: '标准', english: '2m',  description: '推荐默认值' },
    { value: '5m',  label: '宽松', english: '5m',  description: '批量操作' },
    { value: '10m', label: '极宽', english: '10m', description: '仅用于长任务' },
  ],
};

/** 识别"超时类"key，便于走 preset 卡片渲染。 */
function isTimeoutKey(key: string): keyof typeof timeoutPresets | null {
  if (key in timeoutPresets) return key as keyof typeof timeoutPresets;
  return null;
}

const sshProxyFields: FieldDefinition[] = [
  { key: 'sshProxyHost', label: '代理主机', placeholder: 'http://proxy.example.com', badge: 'HOST' },
  { key: 'sshProxyPort', label: '代理端口', type: 'number', placeholder: '7890', badge: 'TCP' },
  { key: 'sshProxyUsername', label: '代理用户名', placeholder: '可选' },
  { key: 'sshProxyPassword', label: '代理密码', type: 'password',
    help: '留空表示保留现有密码。' },
];

const localStorageFields: FieldDefinition[] = [
  { key: 'localPublicBaseUrl', label: '文件下载地址（可选）', wide: true,
    help: '通常留空，系统会根据当前访问地址自动生成。', badge: 'PUBLIC URL' },
  { key: 'localSigningSecret', label: '下载链接签名密钥（高级）', type: 'password', wide: true,
    help: '通常留空。留空表示保留已有密钥或继续使用随机密钥。' },
];

const minioFields: FieldDefinition[] = [
  { key: 'minioEndpoint', label: 'MinIO API 地址', wide: true, badge: 'ENDPOINT' },
  { key: 'minioPublicEndpoint', label: '外部下载地址（可选）', wide: true,
    help: '客户端无法直接访问 MinIO API 地址时再填写，留空则使用上面的地址。', badge: 'PUBLIC' },
  { key: 'minioAccessKey', label: 'Access Key', type: 'password', help: '留空表示保留现有值。' },
  { key: 'minioSecretKey', label: 'Secret Key', type: 'password', help: '留空表示保留现有值。' },
  { key: 'minioBucket', label: '存储桶', kind: 'bucket', placeholder: 'ai-ssh-uploads', badge: 'BUCKET' },
  { key: 'minioRegion', label: '区域', placeholder: 'us-east-1', badge: 'REGION' },
  { key: 'minioConnectTimeout', label: '连接超时', kind: 'timeout' },
  { key: 'minioReadTimeout', label: '读取超时', kind: 'timeout' },
  { key: 'minioWriteTimeout', label: '写入超时', kind: 'timeout' },
  { key: 'minioCallTimeout', label: '请求总超时', kind: 'timeout' },
];

const mediaTypeLabels: Record<string, string> = {
  'image/png': 'PNG 图片',
  'image/jpeg': 'JPG 图片',
  'image/webp': 'WebP 图片',
  'application/pdf': 'PDF 文档',
};

/* ============================================================================
 * 通用工具
 * ========================================================================== */

/** 根据用户填写的数据根目录生成可读预览，不依赖 Node 路径 API。 */
function childPath(root: string, ...parts: string[]) {
  const separator = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].filter(Boolean).join(separator);
}

/** 截断字符串中间以保持前后可见。 */
function collapsePath(value: string, max = 64) {
  if (!value || value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** 区分展示后端状态。 */
type DotStatus = 'loading' | 'ok' | 'warn' | 'error';
function deriveStatus(config: BundledBackendConfig | null, loading: boolean, error: string): DotStatus {
  if (loading) return 'loading';
  if (error) return 'error';
  if (!config) return 'warn';
  return 'ok';
}

/** 把 /api/health 结果收敛成顶栏能直接展示的语义状态。 */
type HealthState = 'idle' | 'probing' | 'up' | 'down' | 'error';
function deriveHealthState(snapshot: BackendHealthSnapshot | null, probing: boolean): HealthState {
  if (probing) return 'probing';
  if (!snapshot) return 'idle';
  return snapshot.ok ? 'up' : 'down';
}

function healthLabel(state: HealthState, snapshot: BackendHealthSnapshot | null): string {
  if (state === 'probing') return '健康检查中…';
  if (state === 'idle') return '尚未做健康检查';
  if (state === 'up') return snapshot?.latencyMs != null ? `健康 · ${snapshot.latencyMs}ms` : '健康 · UP';
  if (state === 'down') return snapshot?.message ? `异常 · ${snapshot.message}` : '异常 · /api/health 未返回 UP';
  return '健康检查失败';
}

function healthToneClass(state: HealthState): string {
  switch (state) {
    case 'up': return 'is-up';
    case 'down': return 'is-down';
    case 'probing': return 'is-loading';
    case 'error': return 'is-error';
    default: return 'is-idle';
  }
}

/* ============================================================================
 * 原子组件
 * ========================================================================== */

function ConfigSource({ meta }: { meta?: BundledBackendConfigValue }) {
  if (!meta?.environmentOverride) return null;
  return <span className="settings-env-override">
    <Icon name="bolt" size={11} />由 {meta.environmentOverride} 控制
  </span>;
}

function StatusDot({ status }: { status: DotStatus }) {
  return <span className={`settings-status-dot is-${status}`} aria-hidden="true"><i /></span>;
}

/**
 * /api/health 探测结果的轻量指示器。
 * 复用 settings-status-dot 的形状，但颜色按 UP / DOWN / probing 区分。
 */
function HealthDot({ state }: { state: HealthState }) {
  return <span className={`settings-status-dot settings-health-dot is-${healthToneClass(state)}`} aria-hidden="true"><i /></span>;
}

function SearchBar({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return <div className="settings-search">
    <Icon name="search" size={14} />
    <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder ?? '在当前页搜索字段…'} />
    {value && <button type="button" aria-label="清空搜索" onClick={() => onChange('')}><Icon name="close" size={11} /></button>}
  </div>;
}

function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options?: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  if (!options?.length) return null;
  return <div className="settings-segmented" role="radiogroup" aria-label={ariaLabel}>
    {options.map(option => <button key={option.value} type="button" role="radio"
      aria-checked={value === option.value}
      className={value === option.value ? 'selected' : ''}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function FieldShell({ definition, meta, children }: {
  definition: FieldDefinition;
  meta?: BundledBackendConfigValue;
  children: ReactNode;
}) {
  const className = `settings-field ${definition.wide ? 'is-wide' : ''} ${definition.type === 'password' ? 'is-secret' : ''}`;
  return <div className={className}>
    <div className="settings-field-head">
      <label htmlFor={`backend-setting-${definition.key}`}>{definition.label}</label>
      <div className="settings-field-meta">
        {meta?.sensitive && <span className="settings-field-secret"><Icon name="shield" size={11} />敏感</span>}
        {definition.badge && <span className="settings-field-badge">{definition.badge}</span>}
        <ConfigSource meta={meta} />
      </div>
    </div>
    {children}
  </div>;
}

/* ============================================================================
 * 字段渲染
 * ========================================================================== */

/* ============================================================================
 * 自定义字段渲染器
 * ========================================================================== */

function ReasoningEffortGrid({ value, change }: {
  value: string;
  change: (next: string) => void;
}) {
  const max = reasoningEffortLevels.length - 1;
  return <div className="settings-reasoning-grid" role="radiogroup" aria-label="推理强度">
    {reasoningEffortLevels.map(level => {
      const selected = value === level.value;
      const ratio = Math.max(level.level / max, 0.08);
      return <button key={level.value} type="button" role="radio"
        aria-checked={selected}
        className={`settings-reasoning-card ${selected ? 'selected' : ''}`}
        onClick={() => change(level.value)}>
        <span className="settings-reasoning-card-head">
          <strong>{level.label}</strong>
          <em>{level.english}</em>
        </span>
        <span className="settings-reasoning-card-desc">{level.description}</span>
        <span className="settings-reasoning-meter" aria-hidden="true">
          <span className="settings-reasoning-meter-fill" style={{ width: `${ratio * 100}%` }} />
        </span>
        <span className="settings-reasoning-card-foot">
          <small>Lv.{level.level}</small>
          {selected && <small className="is-active"><Icon name="check" size={10} />已选择</small>}
        </span>
      </button>;
    })}
  </div>;
}

function PortPresetPicker({ value, change, meta }: {
  value: string;
  change: (next: string) => void;
  meta?: BundledBackendConfigValue;
}) {
  const numeric = Number(value);
  const matched = serverPortPresets.some(item => item.port === numeric);
  return <div className="settings-port-picker">
    <div className="settings-input-wrap">
      <input id="backend-setting-serverPort" type="number" value={value} placeholder="8888"
        className="settings-control" min={1} max={65535}
        onChange={event => change(event.target.value)} />
      <span className="settings-input-suffix">TCP</span>
    </div>
    <div className="settings-port-presets" role="group" aria-label="常用端口预设">
      {serverPortPresets.map(item => <button key={item.port} type="button"
        className={numeric === item.port ? 'selected' : ''}
        onClick={() => change(String(item.port))}>
        <strong>{item.port}</strong>
        <small>{item.note}</small>
      </button>)}
      {meta?.environmentOverride && <span className="settings-port-warning">
        <Icon name="bolt" size={11} />环境变量 {meta.environmentOverride} 覆盖中
      </span>}
      {!matched && value && Number.isInteger(numeric) && numeric > 0 && numeric <= 65535 &&
        <span className="settings-port-hint">
          <Icon name="bulb" size={11} />当前使用自定义端口 {numeric}
        </span>}
    </div>
  </div>;
}

function PathPresetPicker({ value, change, group, meta }: {
  value: string;
  change: (next: string) => void;
  group: string;
  meta?: BundledBackendConfigValue;
}) {
  const presets = openAiPathPresets[group] ?? [];
  return <div className="settings-path-preset">
    <div className="settings-input-wrap">
      <input id={`backend-setting-${group}`} type="text" value={value}
        placeholder="v1/chat/completions" className="settings-control settings-control-mono"
        onChange={event => change(event.target.value)} />
      {meta?.configured && value && <span className="settings-input-suffix">
        <Icon name="check" size={11} />
      </span>}
    </div>
    <div className="settings-path-preset-list" role="group" aria-label="路径快选">
      {presets.map(preset => <button key={preset.label} type="button"
        className={value === preset.path ? 'selected' : ''}
        onClick={() => change(preset.path)}>
        <strong>{preset.label}</strong>
        <code>{preset.english}</code>
      </button>)}
    </div>
  </div>;
}

function TimeoutPresetGrid({ value, change, presets }: {
  value: string;
  change: (next: string) => void;
  presets: { value: string; label: string; english: string; description: string }[];
}) {
  return <div className="settings-timeout-grid" role="radiogroup" aria-label="超时档位">
    {presets.map(preset => <button key={preset.value} type="button" role="radio"
      aria-checked={value === preset.value}
      className={`settings-timeout-card ${value === preset.value ? 'selected' : ''}`}
      onClick={() => change(preset.value)}>
      <span className="settings-timeout-card-head">
        <strong>{preset.label}</strong>
        <em>{preset.english}</em>
      </span>
      <span className="settings-timeout-card-desc">{preset.description}</span>
    </button>)}
  </div>;
}

function BucketHintCard({ value, change }: {
  value: string;
  change: (next: string) => void;
}) {
  const rules = [
    { id: 'length', ok: value.length >= 3 && value.length <= 63, label: '3–63 个字符' },
    { id: 'lower',  ok: /^[a-z0-9.-]+$/.test(value), label: '仅小写字母、数字、点、短横线' },
    { id: 'start',  ok: !value.startsWith('-') && !value.startsWith('.'), label: '不能以 - 或 . 开头或结尾' },
    { id: 'ip',     ok: value === '' || !/^\d+\.\d+\.\d+\.\d+$/.test(value), label: '不能是 IP 地址格式' },
  ];
  const allOk = rules.every(rule => rule.ok);
  return <div className="settings-bucket-card">
    <div className="settings-input-wrap">
      <input id="backend-setting-minioBucket" type="text" value={value}
        placeholder="ai-ssh-uploads" className="settings-control"
        onChange={event => change(event.target.value)} />
      <span className={`settings-input-suffix is-${allOk ? 'ok' : 'warn'}`}>
        <Icon name={allOk ? 'check' : 'alert'} size={11} />
      </span>
    </div>
    <ul className="settings-bucket-rules" aria-label="桶名规则校验">
      {rules.map(rule => <li key={rule.id} className={rule.ok ? 'is-ok' : 'is-warn'}>
        <Icon name={rule.ok ? 'check' : 'close'} size={10} />
        <span>{rule.label}</span>
      </li>)}
    </ul>
  </div>;
}

function HostListEditor({ value, change }: {
  value: string;
  change: (next: string) => void;
}) {
  const items = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const [draft, setDraft] = useState('');
  const [bulkMode, setBulkMode] = useState(false);

  const commit = () => {
    const next = draft.trim();
    if (!next || items.includes(next)) { setDraft(''); return; }
    change([...items, next].join('\n'));
    setDraft('');
  };

  const commitBulk = () => {
    const list = draft.split(/\r?\n|,/).map(part => part.trim()).filter(Boolean);
    const merged = Array.from(new Set([...items, ...list]));
    change(merged.join('\n'));
    setDraft('');
    setBulkMode(false);
  };

  return <div className="settings-host-list">
    <div className="settings-host-list-chips" aria-label="已配置的非代理地址">
      {items.length === 0 && <p className="settings-empty">还没有任何例外地址，代理会对所有请求生效</p>}
      {items.map(item => <span key={item} className="settings-host-chip">
        <Icon name="signal" size={11} />
        <code>{item}</code>
        <button type="button" aria-label={`移除 ${item}`}
          onClick={() => change(items.filter(current => current !== item).join('\n'))}>
          <Icon name="close" size={10} />
        </button>
      </span>)}
    </div>
    {!bulkMode && <div className="settings-host-list-add">
      <div className="settings-host-list-presets" role="group" aria-label="快速添加">
        {nonProxyPresets.map(preset => <button key={preset} type="button"
          className={items.includes(preset) ? 'selected' : ''}
          onClick={() => {
            if (items.includes(preset)) {
              change(items.filter(current => current !== preset).join('\n'));
            } else {
              change([...items, preset].join('\n'));
            }
          }}>
          <Icon name={items.includes(preset) ? 'check' : 'plus'} size={10} />
          {preset}
        </button>)}
      </div>
      <div className="settings-host-list-input">
        <input value={draft} placeholder="输入自定义地址或通配模式，如 *.internal"
          className="settings-control"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === 'Escape') setDraft('');
          }} />
        <button type="button" className="primary-button" onClick={commit} disabled={!draft.trim()}>
          <Icon name="plus" size={12} />添加
        </button>
        <button type="button" className="ghost-button" onClick={() => setBulkMode(true)}>
          <Icon name="edit" size={12} />批量粘贴
        </button>
      </div>
    </div>}
    {bulkMode && <div className="settings-host-list-bulk">
      <textarea value={draft} autoFocus rows={4} placeholder="每行一个地址，匹配 *.example.com / 10.0.0.0/8 等"
        className="settings-control settings-control-textarea"
        onChange={event => setDraft(event.target.value)} />
      <div className="settings-host-list-bulk-actions">
        <button type="button" className="primary-button" onClick={commitBulk}>合并到列表</button>
        <button type="button" className="ghost-button" onClick={() => { setBulkMode(false); setDraft(''); }}>取消</button>
      </div>
    </div>}
  </div>;
}

/* ============================================================================
 * 标准 ConfigField
 * ========================================================================== */

function ConfigField({ definition, values, config, change }: {
  definition: FieldDefinition;
  values: ConfigValues;
  config: BundledBackendConfig;
  change: (key: string, value: string) => void;
}) {
  const meta = config.values[definition.key];
  const value = values[definition.key] ?? '';
  const placeholder = meta?.sensitive && meta.configured ? '已配置，留空表示不修改' : definition.placeholder;
  const [reveal, setReveal] = useState(false);
  const isPassword = definition.type === 'password';

  // 1) 自定义 kind 渲染器
  if (definition.kind === 'reasoning') {
    return <FieldShell definition={definition} meta={meta}>
      <ReasoningEffortGrid value={value} change={next => change(definition.key, next)} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }
  if (definition.kind === 'port') {
    return <FieldShell definition={definition} meta={meta}>
      <PortPresetPicker value={value} change={next => change(definition.key, next)} meta={meta} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }
  if (definition.kind === 'path-preset' && definition.pathGroup) {
    return <FieldShell definition={definition} meta={meta}>
      <PathPresetPicker value={value} change={next => change(definition.key, next)}
        group={definition.pathGroup} meta={meta} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }
  if (definition.kind === 'timeout') {
    const timeoutKey = isTimeoutKey(definition.key);
    if (timeoutKey) {
      return <FieldShell definition={definition} meta={meta}>
        <TimeoutPresetGrid value={value} change={next => change(definition.key, next)}
          presets={timeoutPresets[timeoutKey]} />
        <p className="settings-field-help">支持 5s/30s/60s/2m 这种 Go duration 写法。</p>
      </FieldShell>;
    }
  }
  if (definition.kind === 'bucket') {
    return <FieldShell definition={definition} meta={meta}>
      <BucketHintCard value={value} change={next => change(definition.key, next)} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }
  if (definition.kind === 'host-list') {
    return <FieldShell definition={definition} meta={meta}>
      <HostListEditor value={value} change={next => change(definition.key, next)} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }

  // 2) 基础控件
  let body: ReactNode;
  if (definition.type === 'textarea') {
    body = <textarea id={`backend-setting-${definition.key}`} rows={4} value={value}
      placeholder={placeholder} className="settings-control settings-control-textarea"
      onChange={event => change(definition.key, event.target.value)} />;
  } else if (definition.type === 'choice') {
    body = <SegmentedControl value={value || (definition.options?.[0]?.value ?? '')}
      options={definition.options?.map(o => ({ value: o.value, label: o.label }))}
      onChange={next => change(definition.key, next)}
      ariaLabel={definition.label} />;
  } else if (definition.type === 'toggle') {
    body = <div className="settings-toggle-row">
      <Toggle label={definition.label} value={value === 'true'}
        onChange={next => change(definition.key, String(next))} />
      <span className="settings-toggle-state">{value === 'true' ? '已开启' : '已关闭'}</span>
    </div>;
  } else {
    body = <div className={`settings-input-wrap ${isPassword ? 'is-password' : ''}`}>
      <input id={`backend-setting-${definition.key}`}
        type={isPassword && !reveal ? 'password' : (definition.type ?? 'text')}
        value={value} placeholder={placeholder} className="settings-control"
        autoComplete={isPassword ? 'new-password' : undefined}
        onChange={event => change(definition.key, event.target.value)} />
      {isPassword && meta?.configured && <button type="button" className="settings-input-action"
        aria-label={reveal ? '隐藏内容' : '显示内容'} title={reveal ? '隐藏内容' : '显示内容'}
        onClick={() => setReveal(value => !value)}>
        <Icon name={reveal ? 'shield' : 'key'} size={13} />
      </button>}
    </div>;
  }

  return <FieldShell definition={definition} meta={meta}>
    {body}
    {definition.help && <p className="settings-field-help">{definition.help}</p>}
  </FieldShell>;
}

function BooleanConfigField({ settingKey, label, values, config, change }: {
  settingKey: string;
  label: string;
  values: ConfigValues;
  config: BundledBackendConfig;
  change: (key: string, value: string) => void;
}) {
  const meta = config.values[settingKey];
  const enabled = values[settingKey] === 'true';
  return <FieldShell definition={{ key: settingKey, label }} meta={meta}>
    <div className="settings-toggle-row">
      <Toggle label={label} value={enabled} onChange={value => change(settingKey, String(value))} />
      <span className="settings-toggle-state">{enabled ? '已开启' : '已关闭'}</span>
      <span className="settings-toggle-hint">{enabled ? '对应网络流量将经过该代理' : '不会向代理发送任何请求'}</span>
    </div>
  </FieldShell>;
}

function AddressUrlField({ value, onChange, onTest, testing, onSave }: {
  value: string;
  onChange: (next: string) => void;
  onTest: () => void;
  testing: boolean;
  onSave: () => void;
}) {
  return <div className="settings-address-row">
    <FieldShell definition={{ key: 'serverUrl', label: '后端服务器根地址', wide: true,
      placeholder: 'http://127.0.0.1:8888',
      help: '不要填写 /agent 或 /api/v1/ssh。保存后立即生效，重启仍会保留。' }}>
      <div className="settings-input-wrap">
        <input id="backend-setting-server-url" type="url" value={value}
          placeholder="http://127.0.0.1:8888" className="settings-control"
          onChange={event => onChange(event.target.value)} />
      </div>
    </FieldShell>
    <div className="settings-address-actions">
      <button type="button" className="ghost-button" disabled={testing} onClick={onTest}>
        <Icon name="signal" size={13} />{testing ? '测试中…' : '测试连接'}
      </button>
      <button type="button" className="primary-button" onClick={onSave}>保存地址</button>
    </div>
  </div>;
}

/* ============================================================================
 * 区块组件
 * ========================================================================== */

function MediaTypeEditor({ value, change }: { value: string; change: (value: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const items = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

  const commit = () => {
    const next = draft.trim();
    if (!next || items.includes(next)) { setAdding(false); setDraft(''); return; }
    change([...items, next].join('\n'));
    setAdding(false);
    setDraft('');
  };

  return <div className="settings-media-card">
    <div className="settings-media-head">
      <div>
        <strong>允许上传给模型的文件类型</strong>
        <small>点击标签右上角的 × 可移除。Agent 只会发送列表里的 MIME，附件会先在本地校验。</small>
      </div>
      {!adding && <button type="button" className="settings-chip-button" onClick={() => setAdding(true)}>
        <Icon name="plus" size={12} />新增类型
      </button>}
    </div>
    <div className="settings-media-chips">
      {items.map(item => <span key={item} className="settings-media-chip">
        <span className="settings-media-chip-text">
          <b>{mediaTypeLabels[item] ?? item}</b>
          <small>{mediaTypeLabels[item] ? item : '自定义类型'}</small>
        </span>
        <button type="button" aria-label={`移除 ${mediaTypeLabels[item] ?? item}`}
          onClick={() => change(items.filter(current => current !== item).join('\n'))}>
          <Icon name="close" size={11} />
        </button>
      </span>)}
      {!items.length && <p className="settings-empty">尚未允许任何附件类型</p>}
    </div>
    {adding && <div className="settings-media-add">
      <input value={draft} autoFocus placeholder="例如：text/plain"
        className="settings-control"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') { setAdding(false); setDraft(''); }
        }} />
      <button type="button" className="primary-button" onClick={commit}>添加</button>
      <button type="button" className="outlined-button" onClick={() => { setAdding(false); setDraft(''); }}>取消</button>
    </div>}
  </div>;
}

function ProtocolCard() {
  const [protocol, setProtocol] = useState<'openai'>('openai');
  return <div className="settings-protocol-card">
    <div className="settings-protocol-head">
      <span className="settings-protocol-icon"><Icon name="network" size={16} /></span>
      <div>
        <strong>接口协议</strong>
        <small>当前版本仅支持 OpenAI 兼容协议，后续会逐步开放更多协议。</small>
      </div>
    </div>
    <SegmentedControl value={protocol} onChange={setProtocol} ariaLabel="模型接口协议" options={[
      { value: 'openai', label: 'OpenAI 兼容' },
    ]} />
    <div className="settings-protocol-locked">
      <span><Icon name="shield" size={11} />Anthropic</span>
      <span><Icon name="shield" size={11} />Ollama</span>
      <em>当前版本暂未支持</em>
    </div>
  </div>;
}

function StorageModeSelector({ values, config, change }: {
  values: ConfigValues;
  config: BundledBackendConfig;
  change: (key: string, value: string) => void;
}) {
  const localId = values.localStorageId || 'local-main';
  const minioId = values.minioStorageId || 'minio-main';
  const activeMode = values.fileStorageDefaultId === minioId ? 'minio' : 'local';
  const localEnabled = values.localStorageEnabled === 'true';
  const minioEnabled = values.minioEnabled === 'true';

  const selectMode = (mode: 'local' | 'minio') => {
    change('fileStorageDefaultId', mode === 'local' ? localId : minioId);
    if (mode === 'local' && !localEnabled) change('localStorageEnabled', 'true');
    if (mode === 'minio' && !minioEnabled) change('minioEnabled', 'true');
  };

  const localState = activeMode === 'local'
    ? (localEnabled ? '当前使用' : '当前未启用')
    : (localEnabled ? '备用可用' : '未启用');
  const minioState = activeMode === 'minio'
    ? (minioEnabled ? '当前使用' : '当前未启用')
    : (minioEnabled ? '备用可用' : '未启用');

  return <div className="settings-storage-mode">
    <button type="button" role="radio" aria-checked={activeMode === 'local'}
      className={`settings-storage-card ${activeMode === 'local' ? 'selected' : ''}`}
      onClick={() => selectMode('local')}>
      <span className="settings-storage-icon"><Icon name="folder" size={18} /></span>
      <span className="settings-storage-body">
        <strong>本机存储</strong>
        <small>文件保存在当前电脑，桌面版推荐</small>
        <span className={`settings-storage-pill is-${activeMode === 'local' ? (localEnabled ? 'on' : 'warn') : (localEnabled ? 'idle' : 'off')}`}>{localState}</span>
      </span>
      <span className="settings-storage-tail" onClick={event => event.stopPropagation()}>
        <span className="settings-storage-tail-label">允许使用本机存储</span>
        <Toggle label="启用本机存储" value={localEnabled} onChange={value => change('localStorageEnabled', String(value))} />
      </span>
    </button>
    <button type="button" role="radio" aria-checked={activeMode === 'minio'}
      className={`settings-storage-card ${activeMode === 'minio' ? 'selected' : ''}`}
      onClick={() => selectMode('minio')}>
      <span className="settings-storage-icon"><Icon name="server" size={18} /></span>
      <span className="settings-storage-body">
        <strong>MinIO 存储</strong>
        <small>文件保存在独立对象存储服务器</small>
        <span className={`settings-storage-pill is-${activeMode === 'minio' ? (minioEnabled ? 'on' : 'warn') : (minioEnabled ? 'idle' : 'off')}`}>{minioState}</span>
      </span>
      <span className="settings-storage-tail" onClick={event => event.stopPropagation()}>
        <span className="settings-storage-tail-label">允许使用 MinIO</span>
        <Toggle label="启用 MinIO" value={minioEnabled} onChange={value => change('minioEnabled', String(value))} />
      </span>
    </button>
    <ConfigSource meta={config.values.fileStorageDefaultId} />
    {((activeMode === 'local' && !localEnabled) || (activeMode === 'minio' && !minioEnabled)) &&
      <p className="settings-storage-warning">
        <Icon name="alert" size={12} />
        当前选择的存储尚未启用，上传会失败。请开启它或选择另一种存储。
      </p>}
  </div>;
}

function TabSaveBar({ scope, hint, saving, dirty, onSave, onReset }: {
  scope: string;
  hint: string;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return <div className="settings-tab-save" data-scope={scope}>
    <div className="settings-tab-save-meta">
      <strong><Icon name="check" size={12} />{scope}</strong>
      <span>{hint}</span>
    </div>
    <div className="settings-tab-save-actions">
      {dirty && <span className="settings-tab-save-flag">
        <Icon name="edit" size={10} />有未保存的修改
      </span>}
      <button type="button" className="ghost-button" disabled={saving || !dirty} onClick={onReset}>
        <Icon name="history" size={12} />放弃
      </button>
      <button type="button" className="primary-button" disabled={saving} onClick={onSave}>
        <Icon name="check" size={12} />{saving ? '保存中…' : `保存${scope}配置`}
      </button>
    </div>
  </div>;
}

function SettingsGroup({ title, description, badge, children }: {
  title: string;
  description?: string;
  badge?: string;
  children: ReactNode;
}) {
  return <section className="settings-group">
    <header>
      <div>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {badge && <span className="settings-group-badge">{badge}</span>}
    </header>
    <div className="settings-group-body">{children}</div>
  </section>;
}

function PathPreviewCard({ label, icon, path, hint }: {
  label: string;
  icon: 'folder' | 'disk' | 'file';
  path?: string;
  hint?: string;
}) {
  return <div className="settings-path-preview">
    <span><Icon name={icon} size={14} />{label}</span>
    <code title={path}>{path ? collapsePath(path, 72) : '—'}</code>
    {hint && <small>{hint}</small>}
  </div>;
}

/* ============================================================================
 * 主组件
 * ========================================================================== */

export function BackendSettingsDialog({ currentUrl, required = false, onClose, onSave }: BackendSettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [url, setUrl] = useState(currentUrl);
  const [config, setConfig] = useState<BundledBackendConfig | null>(null);
  const [values, setValues] = useState<ConfigValues>({});
  const [loading, setLoading] = useState(isTauriRuntime());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  /** 默认 true 表示桌面壳会自动拉起本地后端；用户关掉时启动阶段停在 stopped。 */
  const [autoStartEnabled, setAutoStartEnabled] = useState(true);
  const [autoStartAvailable, setAutoStartAvailable] = useState(false);
  const [autoStartError, setAutoStartError] = useState('');
  /**
   * 设置页中"启动内置服务"按钮的 loading 状态。
   * 跟启动页的 startupStarting 是两套：这里用户在客户端里点，不需要切启动页。
   * 设置页弹一个小提示（来自状态消息）就够了。
   */
  const [settingsStarting, setSettingsStarting] = useState(false);
  /**
   * 当前后端运行状态。仅用来决定"启动内置服务"按钮是否展示：
   * running 时不展示（避免误操作重启），其余状态都展示。
   * null 表示还没读到或者桌面壳没有这个命令（旧版本），按"未在跑"处理。
   */
  const [backendStatus, setBackendStatus] = useState<BundledBackendStatus | null>(null);
  /**
   * 后端 /api/health 探测结果。仅用于 UI 展示，不影响任何按钮的可用性。
   * - 在桌面壳里随 bundled_backend_status 的轮询节奏触发；
   * - 在浏览器开发模式下，URL 改动或"测试连接"时也会触发；
   * - 与 bundled_backend_status 是互补的：后者描述 Java 进程生命周期，
   *   前者证明 HTTP 端点真的在响应。
   */
  const [healthSnapshot, setHealthSnapshot] = useState<BackendHealthSnapshot | null>(null);
  const [healthProbing, setHealthProbing] = useState(false);
  const [healthError, setHealthError] = useState('');
  const healthAbortRef = useRef<AbortController | null>(null);
  const healthUrlRef = useRef<string>('');

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void readBundledBackendConfig()
      .then(next => {
        if (!active || !next) return;
        setConfig(next);
        setValues(Object.fromEntries(Object.entries(next.values).map(([key, meta]) => [key, meta.value])));
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  /** 单独拉取自动启动偏好；浏览器开发模式不展示这个开关。 */
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void readBundledBackendAutoStart()
      .then(value => {
        if (!active || value === null) return;
        setAutoStartAvailable(true);
        setAutoStartEnabled(value);
      })
      .catch(cause => {
        if (!active) return;
        // 读取失败通常意味着旧版本桌面壳；开关保持可见但禁用作 fallback。
        setAutoStartError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, []);

  /** 拉取后端运行状态，用来决定"启动内置服务"按钮是否显示。仅在桌面壳里生效。 */
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const refresh = () => {
      void readBundledBackendStatus()
        .then(s => { if (active) setBackendStatus(s); })
        .catch(() => { if (active) setBackendStatus(null); });
    };
    refresh();
    // 后端状态变化不频繁（启动/停止/失败），1.5s 轮询够用且不打扰用户。
    const timer = window.setInterval(refresh, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  /**
   * 探测 /api/health。
   * 单一入口让多个 effect 共用，避免重复 fetch；URL 变化或 bundled_backend_status
   * 切到 running 都会触发它。
   */
  const runHealthProbe = useCallback(async (targetUrl: string) => {
    healthAbortRef.current?.abort();
    const controller = new AbortController();
    healthAbortRef.current = controller;
    healthUrlRef.current = targetUrl;
    setHealthProbing(true);
    setHealthError('');
    try {
      const snapshot = await probeBackendHealth({
        backendUrl: targetUrl,
        signal: controller.signal,
      });
      // 期间 URL 又被改了，就丢弃旧结果，避免“填了新地址却显示旧探测”的错乱。
      if (healthUrlRef.current !== targetUrl) return;
      setHealthSnapshot(snapshot);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (healthUrlRef.current !== targetUrl) return;
      setHealthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (healthAbortRef.current === controller) {
        setHealthProbing(false);
        healthAbortRef.current = null;
      }
    }
  }, []);

  /**
   * 桌面壳里，后端一旦被 Rust 报告为 running，就顺手用 /api/health 做一次确认。
   * running 但 /api/health 不通 = 端口已开但 Spring 还没就绪 / 业务 Bean 初始化失败，
   * 这是个真实的运维场景，单独靠 bundled_backend_status 看不出来。
   */
  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (backendStatus?.status !== 'running') return;
    void runHealthProbe(currentUrl);
  }, [backendStatus?.status, backendStatus?.message, currentUrl, runHealthProbe]);

  /**
   * 浏览器开发模式 / 用户切换“客户端访问地址”时也补一次探测，让顶栏徽章跟着走。
   * 桌面壳里 currentUrl 跟启动页拉的地址一致，依赖上面那个 effect 触发即可。
   */
  useEffect(() => {
    if (isTauriRuntime()) return;
    if (!currentUrl) return;
    void runHealthProbe(currentUrl);
  }, [currentUrl, runHealthProbe]);

  /** 卸载时取消未结束的探测。 */
  useEffect(() => () => { healthAbortRef.current?.abort(); }, []);

  /**
   * 切换自动启动。注意：开关本身只描述“客户端启动时是否自动拉起后端”，
   * 它的生效时机是下一次打开客户端；切换当下不立即拉/停 Java。
   * 关闭时 Rust 端会顺手 stop 当前 Java（避免开关状态和实际状态不一致），
   * 打开时不动 Java —— 用户如果想立刻用，可以点“启动内置服务”按钮。
   */
  const toggleAutoStart = async () => {
    setAutoStartError('');
    const next = !autoStartEnabled;
    setAutoStartEnabled(next);
    setSettingsStarting(false);
    try {
      const confirmed = await setBundledBackendAutoStart(next);
      if (confirmed !== null) setAutoStartEnabled(confirmed);
      // 立刻刷一次后端状态，让按钮按实际情况显隐；
      // 关闭时 Rust 已经 stop 了，按钮应出现；打开时不动 Java，按钮的显示取决于原状态。
      void readBundledBackendStatus().then(s => setBackendStatus(s)).catch(() => {});
    } catch (cause) {
      setAutoStartEnabled(!next);
      setAutoStartError(cause instanceof Error ? cause.message : '切换自动启动失败。');
    }
  };

  /**
   * 在客户端内部手动拉起本地 Java。
   * 复用 restart 命令：它会先 stop 再 start，确保进程状态干净；
   * 启动完成后我们再读一次状态展示给用户。
   */
  const startManuallyFromSettings = async () => {
    setAutoStartError('');
    setSettingsStarting(true);
    try {
      // 用 restart 而不是 start，是因为用户可能想"重启"——比如改完配置后。
      const status = await restartBundledBackend();
      setBackendStatus(status);
      if (status?.status === 'running') {
        // 正常路径：按钮会立刻被 status 驱动切到“停止内置后端”。
        setResult(`已启动：${status.message || '内置后端已就绪'}`);
      } else if (status?.status === 'failed') {
        setAutoStartError(status.message || '启动失败');
      } else if (status?.status === 'stopped') {
        setAutoStartError(status.message || '未启动，请到启动页查看详情');
      } else {
        setResult(status?.message || '正在启动…');
      }
    } catch (cause) {
      setAutoStartError(cause instanceof Error ? cause.message : '启动失败。');
    } finally {
      setSettingsStarting(false);
    }
  };

  /**
   * 停止内置后端。直接调用 stop 命令（已存在），不在这里处理偏好。
   * 偏好跟“运行/停止”解耦：偏好决定“下次开客户端时是否自动起”，
   * 而这个按钮是“当前要不要让它在跑”。
   */
  const stopManuallyFromSettings = async () => {
    setAutoStartError('');
    setSettingsStarting(true);
    try {
      const status = await stopBundledBackend();
      setBackendStatus(status);
      setResult(`已停止：${status?.message || '内置后端已停止'}`);
    } catch (cause) {
      setAutoStartError(cause instanceof Error ? cause.message : '停止失败。');
    } finally {
      setSettingsStarting(false);
    }
  };

  const change = (key: string, value: string) => {
    setValues(current => ({ ...current, [key]: value }));
    setError('');
    setResult('');
  };

  const testConnection = async () => {
    setError('');
    setResult('');
    let address: string;
    try { address = normalizeBackendUrl(url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '地址无效。'); return; }
    setTesting(true);
    try {
      // 复用 /api/health 探测：同时承担“测试连接”和“健康检查”。
      // 它是后端最轻的存活探针，HTTP 200 + status === "UP" 即可证明 Web 容器可用，
      // 后续的 Agent 业务接口再由真实业务调用兜底。
      const snapshot = await probeBackendHealth({ backendUrl: address });
      if (snapshot.ok) {
        const latency = snapshot.latencyMs != null ? `（${snapshot.latencyMs}ms）` : '';
        setResult(`连接成功，/api/health 返回 UP${latency}。`);
      } else {
        setError(snapshot.message || '/api/health 未返回 UP。');
      }
      // 让顶栏徽章立刻反映这次手动探测的结果。
      setHealthSnapshot(snapshot);
      setHealthProbing(false);
      healthUrlRef.current = address;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败。');
    } finally {
      setTesting(false);
    }
  };

  const saveAddress = () => {
    setError('');
    try {
      onSave(normalizeBackendUrl(url));
      setResult('客户端访问地址已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存后端地址失败。');
    }
  };

  /**
   * 保存单个 tab 的配置：只把该 tab 的 keys 写入 YAML，未提交的字段保留原值。
   * Rust 侧 `save_backend_config` 行为是逐 key 更新，所以这种"按 tab 保存"是天然支持的。
   */
  const saveTab = async (scope: SettingsSection) => {
    const definition = sectionItems.find(item => item.id === scope);
    if (!definition) return;
    setError('');
    setResult('');
    setSaving(true);
    try {
      if (definition.id === 'general') {
        const port = Number(values.serverPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('后端端口必须是 1 到 65535 之间的整数。');
        }
      }
      const editableValues: Record<string, string> = {};
      for (const key of definition.keys) {
        if (RESERVED_KEYS.has(key)) continue;
        if (!(key in values)) continue;
        editableValues[key] = values[key] ?? '';
      }
      const saved = await saveBundledBackendConfig({ values: editableValues });
      if (saved) {
        setConfig(saved);
        setValues(Object.fromEntries(Object.entries(saved.values).map(([key, meta]) => [key, meta.value])));
      }
      setResult(`${definition.label}配置已保存到 YAML，内置后端不会自动重启。`);
      if (definition.id === 'general') {
        const localUrl = `http://127.0.0.1:${values.serverPort || '8888'}`;
        setUrl(localUrl);
        onSave(localUrl);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /** 判断某个 tab 内是否有"未保存的修改"：values 与 config.values 该 tab 子集中存在差异。 */
  const isTabDirty = (scope: SettingsSection): boolean => {
    const definition = sectionItems.find(item => item.id === scope);
    if (!definition || !config) return false;
    for (const key of definition.keys) {
      if (RESERVED_KEYS.has(key)) continue;
      if (!(key in values)) continue;
      const current = values[key] ?? '';
      const original = config.values[key]?.value ?? '';
      if (current !== original) return true;
    }
    return false;
  };

  /** 重置某个 tab 的 values 到 config.values 中的对应值。 */
  const resetTab = (scope: SettingsSection) => {
    if (!config) return;
    setValues(previous => {
      const next = { ...previous };
      const definition = sectionItems.find(item => item.id === scope);
      if (!definition) return previous;
      for (const key of definition.keys) {
        next[key] = config.values[key]?.value ?? '';
      }
      return next;
    });
    setError('');
    setResult('');
  };

  const renderFields = (fields: FieldDefinition[]) => {
    if (!config) return null;
    const filtered = search
      ? fields.filter(field => {
          const target = `${field.label} ${field.key} ${field.help ?? ''}`.toLowerCase();
          return target.includes(search.toLowerCase());
        })
      : fields;
    if (!filtered.length) return <p className="settings-empty">没有匹配 “{search}” 的字段</p>;
    return <div className="settings-fields-grid">
      {filtered.map(field => <ConfigField key={field.key} definition={field} values={values} config={config} change={change} />)}
    </div>;
  };

  const status = deriveStatus(config, loading, error);
  const healthState = deriveHealthState(healthSnapshot, healthProbing);
  const healthLabelText = healthLabel(healthState, healthSnapshot);
  const activeStorageMode = values.fileStorageDefaultId === (values.minioStorageId || 'minio-main') ? 'minio' : 'local';

  return <main className={`settings-page ${required ? 'is-standalone' : ''}`} aria-label="客户端设置">
    {/* ============================== 顶栏 ============================== */}
    <header className="settings-topbar">
      <div className="settings-topbar-left">
        {!required && <button type="button" className="settings-back-button" onClick={onClose} aria-label="返回终端">
          <Icon name="left" size={16} />返回
        </button>}
        <div className="settings-topbar-title">
          <h1>客户端与内置后端设置</h1>
          <p>修改后会立即写入对应 YAML；不会自动重启后端，下次启动客户端或手动重启后生效。</p>
        </div>
      </div>
      <div className="settings-topbar-right">
        <button
          type="button"
          className={`settings-topbar-status settings-health-pill ${healthToneClass(healthState)}`}
          onClick={() => { void runHealthProbe(currentUrl); }}
          title={healthSnapshot ? `${healthSnapshot.backendUrl}/api/health · ${healthSnapshot.checkedAt}` : '点击重新探测 /api/health'}
          aria-label="重新探测 /api/health"
        >
          <HealthDot state={healthState} />
          <span>{healthLabelText}</span>
        </button>
        <div className={`settings-topbar-status is-${status}`}>
          <StatusDot status={status} />
          <span>{status === 'loading' ? '正在读取配置…'
            : status === 'error' ? '读取失败'
            : status === 'warn' ? '未读取到配置'
            : '内置后端已就绪'}</span>
          {config && <code title={config.activeProfiles.join(', ')}>{config.activeProfiles.join(', ') || '默认 profile'}</code>}
        </div>
        {config && <button type="button" className="ghost-button" onClick={() => void openPath(config.configDirectory)}>
          <Icon name="folder" size={14} />配置目录
        </button>}
      </div>
    </header>

    {/* ============================== 主体 ============================== */}
    <div className="settings-body">
      {/* 侧导航 */}
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-search">
          <SearchBar value={search} onChange={setSearch} placeholder="搜索字段（仅当前页）" />
        </div>
        <div className="settings-nav-list">
          {sectionItems.map(item => <button key={item.id} type="button"
            className={`settings-nav-item ${activeSection === item.id ? 'selected' : ''}`}
            aria-current={activeSection === item.id ? 'page' : undefined}
            onClick={() => setActiveSection(item.id)}>
            <span className="settings-nav-icon"><Icon name={item.icon} size={17} /></span>
            <span className="settings-nav-text">
              <strong>{item.label}</strong>
              <small>{item.caption}</small>
            </span>
            <span className="settings-nav-arrow"><Icon name="right" size={12} /></span>
          </button>)}
        </div>
        {config && <div className="settings-nav-footer">
          <span className="settings-nav-footer-label">配置目录</span>
          <code title={config.configDirectory}>{collapsePath(config.configDirectory, 38)}</code>
          <small>字段写回各自 YAML，并生成 .bak 备份。</small>
        </div>}
      </aside>

      {/* 内容区 */}
      <section className="settings-content">
        {loading && <div className="settings-skeleton" aria-label="正在读取配置">
          <span style={{ width: '92%' }} />
          <span style={{ width: '74%' }} />
          <span style={{ width: '88%' }} />
          <span style={{ width: '62%' }} />
          <span style={{ width: '80%' }} />
        </div>}

        {!loading && activeSection === 'general' && <>
          {autoStartAvailable && <SettingsGroup title="启动方式"
            description="关闭后，桌面壳打开时不会自动拉起本地 Java，你也可以在启动页或此处手动启动。"
            badge="启动">
            <div className="settings-toggle-row">
              <span className="settings-toggle-state">{autoStartEnabled ? '自动启动' : '手动启动'}</span>
              <Toggle
                label="自动启动内置后端"
                value={autoStartEnabled}
                onChange={() => void toggleAutoStart()}
              />
              <span className="settings-toggle-hint">
                {autoStartEnabled
                  ? '每次打开客户端都会自动启动内置后端'
                  : '客户端启动时不会拉起 Java，可在此或启动页点击“启动内置服务”'}
              </span>
            </div>
            {autoStartError && <div className="settings-error">{autoStartError}</div>}
            {(() => {
              // 按钮永远显示，文案/样式/handler 跟着当前后端状态走。
              // running → "停止内置服务"（警告色，stop 命令）；
              // 其他状态 → "启动内置服务"（主色，restart 命令，重置干净）。
              const running = backendStatus?.status === 'running';
              const busy = settingsStarting;
              const onClick = running
                ? () => void stopManuallyFromSettings()
                : () => void startManuallyFromSettings();
              const label = busy
                ? (running ? '正在停止…' : '正在启动…')
                : (running ? '停止内置服务' : '启动内置服务');
              const hint = busy
                ? '等待本地服务状态变化'
                : (running
                    ? (autoStartEnabled
                        ? '下次打开客户端会重新拉起；现在先停掉释放资源'
                        : '当前服务在跑，点击立即停止')
                    : (autoStartEnabled
                        ? '自动启动已开启，但内置服务未运行；点击立即拉起'
                        : '点击手动拉起本地 Java 进程'));
              return (
                <div className="settings-toggle-row" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className={running ? 'danger-button' : 'primary-button'}
                    onClick={onClick}
                    disabled={busy}
                  >
                    <Icon name={running ? 'stop' : 'play'} size={14} />
                    {label}
                  </button>
                  <span className="settings-toggle-hint">{hint}</span>
                </div>
              );
            })()}
          </SettingsGroup>}
          <SettingsGroup title="后端健康检查"
            description="调用当前地址的 /api/health，验证 HTTP 端点真实可用；与内置后端的进程状态互补，端口已开但 Spring 还没就绪时也会给出明确提示。"
            badge="健康检查">
            <div className="settings-health-card">
              <div className="settings-health-card-row">
                <HealthDot state={healthState} />
                <strong>{healthLabelText}</strong>
                <code title={healthSnapshot?.backendUrl}>{healthSnapshot?.backendUrl || currentUrl}</code>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={healthProbing}
                  onClick={() => { void runHealthProbe(currentUrl); }}
                >
                  <Icon name="refresh" size={12} />
                  {healthProbing ? '探测中…' : '重新探测'}
                </button>
              </div>
              <p className="settings-health-card-hint">
                {healthState === 'idle' && '点击“重新探测”可立即验证当前地址；自动启动开启时，后端进入 running 状态后会自动探测一次。'}
                {healthState === 'probing' && '正在等待后端返回 2xx 与 status:UP…'}
                {healthState === 'up' && (healthSnapshot?.latencyMs != null
                  ? `已联通，HTTP 200 + status:UP，单次往返 ${healthSnapshot.latencyMs}ms。`
                  : '已联通，HTTP 200 + status:UP。')}
                {healthState === 'down' && (healthSnapshot?.message
                  ? `原因：${healthSnapshot.message}`
                  : '/api/health 没有返回 status:UP。')}
                {healthState === 'error' && (healthError || '探测失败，请检查后端地址、网络与 CORS 设置。')}
              </p>
              {healthSnapshot?.checkedAt && <p className="settings-health-card-time">
                上次探测：{new Date(healthSnapshot.checkedAt).toLocaleString()} · {healthSnapshot.usingCustomUrl ? '本次为手动指定地址' : '本次为客户端配置地址'}
              </p>}
            </div>
          </SettingsGroup>
          <SettingsGroup title="客户端访问地址"
            description="可连接外部后端，也可以使用安装包内置后端。"
            badge="客户端级">
            <AddressUrlField value={url} onChange={setUrl}
              testing={testing} onTest={() => void testConnection()} onSave={saveAddress} />
          </SettingsGroup>
          {config && <SettingsGroup title="运行与数据目录"
            description="修改端口后客户端会自动切换地址；数据目录必须使用绝对路径。"
            badge="运行时">
            {renderFields(generalFields)}
            <div className="settings-derived-paths">
              <PathPreviewCard label="SQLite 数据库" icon="disk" hint="存放对话、上传元数据等所有关系数据"
                path={childPath(values.dataDirectory, 'data', 'ai-ssh-terminal.db') || config.sqliteFile} />
              <PathPreviewCard label="上传文件" icon="file"
                hint={config.values.localRootDirectory?.environmentOverride ? '由系统环境变量控制' : '跟随统一数据目录的 files 子目录'}
                path={config.values.localRootDirectory?.environmentOverride
                  ? values.localRootDirectory
                  : childPath(values.dataDirectory, 'files') || config.uploadDirectory} />
              <PathPreviewCard label="运行日志" icon="folder"
                hint="包含 backend-console.log，可在排查问题时提供上下文"
                path={childPath(values.dataDirectory, 'logs') || config.logDirectory} />
            </div>
          </SettingsGroup>}
          <TabSaveBar scope="连接" hint="修改端口后客户端会立即切换地址；其他字段下次启动后端时生效。"
            saving={saving} dirty={isTabDirty('general')}
            onSave={() => void saveTab('general')} onReset={() => resetTab('general')} />
        </>}

        {!loading && activeSection === 'model' && config && <>
          <SettingsGroup title="模型渠道"
            description="配置后端调用的大模型服务。"
            badge="模型">
            <ProtocolCard />
            {renderFields(modelFields)}
          </SettingsGroup>
          <SettingsGroup title="附件能力"
            description="控制 Agent 可以发送给模型的文件类型。"
            badge="附件">
            <MediaTypeEditor value={values.aiSupportedMediaTypes ?? ''} change={value => change('aiSupportedMediaTypes', value)} />
          </SettingsGroup>
          <TabSaveBar scope="模型" hint="保存后端读取到新配置需要重启；模型密钥留空表示保留现有值。"
            saving={saving} dirty={isTabDirty('model')}
            onSave={() => void saveTab('model')} onReset={() => resetTab('model')} />
        </>}

        {!loading && activeSection === 'proxy' && config && <>
          <SettingsGroup title="AI 接口代理"
            description="仅影响模型对话与向量接口发出的 HTTP 请求。"
            badge="HTTP">
            <BooleanConfigField settingKey="aiProxyEnabled" label="启用 AI HTTP 代理"
              values={values} config={config} change={change} />
            {renderFields(aiProxyFields)}
          </SettingsGroup>
          <SettingsGroup title="SSH HTTP 代理"
            description="用于 SSH 连接需要经过 HTTP 代理服务器的场景。"
            badge="HTTP">
            <BooleanConfigField settingKey="sshProxyEnabled" label="启用 SSH HTTP 代理"
              values={values} config={config} change={change} />
            {renderFields(sshProxyFields)}
          </SettingsGroup>
          <TabSaveBar scope="代理" hint="新连接会使用新代理规则；已有 SSH 连接仍按原配置保持。"
            saving={saving} dirty={isTabDirty('proxy')}
            onSave={() => void saveTab('proxy')} onReset={() => resetTab('proxy')} />
        </>}

        {!loading && activeSection === 'storage' && config && <>
          <SettingsGroup title="系统使用哪种存储"
            description="选择系统实际保存新文件的位置。切换选项时会自动启用对应存储。"
            badge="存储">
            <StorageModeSelector values={values} config={config} change={change} />
          </SettingsGroup>
          {activeStorageMode === 'local' && <SettingsGroup title="本机存储设置"
            description="当前已选择本机存储，文件直接保存在这台电脑。"
            badge="本地">
            <PathPreviewCard label="文件保存位置" icon="folder"
              hint="跟随“基础设置”里的统一数据目录，无需单独维护。"
              path={config.values.localRootDirectory?.environmentOverride
                ? values.localRootDirectory
                : childPath(values.dataDirectory, 'files') || values.localRootDirectory || config.uploadDirectory} />
            {renderFields(localStorageFields)}
          </SettingsGroup>}
          {activeStorageMode === 'minio' && <SettingsGroup title="MinIO 对象存储设置"
            description="当前已选择 MinIO。请确认存储桶已经创建，API 地址不能填写控制台地址。"
            badge="对象存储">
            {renderFields(minioFields)}
          </SettingsGroup>}
          <TabSaveBar scope="存储" hint="新上传会按新存储设置生效；已有上传不会迁移。"
            saving={saving} dirty={isTabDirty('storage')}
            onSave={() => void saveTab('storage')} onReset={() => resetTab('storage')} />
        </>}

        {error && <p className="settings-banner is-error" role="alert">
          <Icon name="alert" size={13} />{error}
        </p>}
        {result && <p className="settings-banner is-success" role="status">
          <Icon name="check" size={13} />{result}
        </p>}
      </section>
    </div>
  </main>;
}