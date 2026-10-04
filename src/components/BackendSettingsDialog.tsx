import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig,
  readBundledBackendStatus,
  restartBundledBackend,
  saveBundledBackendConfig,
  type BundledBackendConfig,
  type BundledBackendConfigValue,
  type BundledBackendStatus,
} from '../api/bundledBackend';
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
type FieldKind = 'reasoning' | 'port' | 'path-preset' | 'timeout' | 'bucket' | 'host-list' | 'service-secret';

type FieldDefinition = {
  key: string;
  label: string;
  help?: string;
  type?: FieldType;
  kind?: FieldKind;
  placeholder?: string;
  options?: { value: string; label: string }[];
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
  { key: 'dataDirectory', label: '统一数据目录', placeholder: '/var/lib/ai-ssh-terminal',
    help: 'SQLite、上传文件、运行日志都会派生在该目录下。修改路径不会迁移任何旧数据。' },
];

/** BaseURL：与 API Key 并排一行 */
const modelBaseFields: FieldDefinition[] = [
  { key: 'aiBaseUrl', label: '服务地址', placeholder: 'http://127.0.0.1:8777/',
    help: 'OpenAI 兼容根地址。', badge: 'BASE URL' },
];

/** API Key：与 BaseURL 并排一行，仅展示眼睛按钮，不允许复制/随机/恢复默认。 */
const modelApiKeyFields: FieldDefinition[] = [
  { key: 'aiApiKey', label: 'API Key', type: 'password', kind: 'service-secret',
    badge: 'OPENAI 兼容密钥',
    help: 'OpenAI 兼容协议下的大模型调用密钥。留空保留原值。' },
];

/** 对话接口路径：独占一行 */
const modelChatField: FieldDefinition[] = [
  { key: 'aiCompletionsPath', label: '对话路径', placeholder: 'v1/chat/completions' },
];

/** 向量接口路径：与推理强度并排一行 */
const modelEmbedField: FieldDefinition[] = [
  { key: 'aiEmbeddingsPath', label: '向量路径', placeholder: 'v1/embeddings' },
];

/** 模型名称：独占一行 */
const modelNameField: FieldDefinition[] = [
  { key: 'aiModelName', label: '模型名称', placeholder: 'gpt-5.5', badge: 'MODEL' },
];

const aiProxyFields: FieldDefinition[] = [
  { key: 'aiProxyHost', label: '代理主机', placeholder: 'http://proxy.example.com', badge: 'HOST' },
  { key: 'aiProxyPort', label: '代理端口', type: 'number', placeholder: '7890', badge: 'TCP' },
  { key: 'aiNonProxyHosts', label: '不使用代理的地址', kind: 'host-list',
    help: '每行填写一个地址或通配模式，命中后请求绕过代理。' },
];

const sshProxyFields: FieldDefinition[] = [
  { key: 'sshProxyHost', label: '代理主机', placeholder: 'http://proxy.example.com', badge: 'HOST' },
  { key: 'sshProxyPort', label: '代理端口', type: 'number', placeholder: '7890', badge: 'TCP' },
  { key: 'sshProxyUsername', label: '代理账号', placeholder: 'optional', badge: 'USER' },
  { key: 'sshProxyPassword', label: '代理密码', type: 'password', kind: 'service-secret',
    help: '留空表示保留现有密码。' },
];

/** 推理强度档位：中英文 + 描述 + 等级（0-7），UI 用网格卡片渲染。 */
const reasoningEffortLevels: { value: string; label: string; english: string; description: string; level: number }[] = [
  { value: 'none',    label: '关闭', english: 'None',       description: '不启用推理',       level: 0 },
  { value: 'minimal', label: '极低', english: 'Minimal',    description: '几乎无额外思考',    level: 1 },
  { value: 'low',     label: '低',   english: 'Low',        description: '略加推理',         level: 2 },
  { value: 'medium',  label: '中',   english: 'Medium',     description: '默认平衡',         level: 3 },
  { value: 'high',    label: '高',   english: 'High',       description: '深入思考',         level: 4 },
  { value: 'xhigh',   label: '很高', english: 'Extra High', description: '长链路分析',        level: 5 },
  { value: 'max',     label: '最高', english: 'Maximum',    description: '接近全量推理',      level: 6 },
  { value: 'ultra',   label: '极致', english: 'Ultra',      description: '极耗 token',      level: 7 },
];

/** 非代理地址快速示例。 */
const nonProxyPresets = ['localhost', '127.0.0.1', '10.*', '192.168.*', '*.local'];

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

const localStorageFields: FieldDefinition[] = [
  { key: 'localPublicBaseUrl', label: '文件下载地址（可选）',
    help: '通常留空，系统会根据当前访问地址自动生成。', badge: 'PUBLIC URL' },
  { key: 'localSigningSecret', label: '下载链接签名密钥（高级）', type: 'password',
    help: '通常留空。留空表示保留已有密钥或继续使用随机密钥。' },
];

const minioFields: FieldDefinition[] = [
  { key: 'minioEndpoint', label: 'MinIO API 地址', badge: 'ENDPOINT' },
  { key: 'minioPublicEndpoint', label: '外部下载地址（可选）',
    help: '客户端无法直接访问 MinIO API 地址时再填写，留空则使用上面的地址。', badge: 'PUBLIC' },
  { key: 'minioAccessKey', label: 'Access Key', type: 'password', kind: 'service-secret',
    placeholder: '留空表示保留现有值', badge: 'ACCESS' },
  { key: 'minioSecretKey', label: 'Secret Key', type: 'password', kind: 'service-secret',
    placeholder: '留空表示保留现有值', badge: 'SECRET' },
  { key: 'minioBucket', label: '存储桶', kind: 'bucket', placeholder: 'ai-ssh-uploads', badge: 'BUCKET' },
  { key: 'minioRegion', label: '区域', placeholder: 'us-east-1', badge: 'REGION' },
  { key: 'minioConnectTimeout', label: '连接超时', kind: 'timeout' },
  { key: 'minioReadTimeout', label: '读取超时', kind: 'timeout' },
  { key: 'minioWriteTimeout', label: '写入超时', kind: 'timeout' },
  { key: 'minioCallTimeout', label: '请求总超时', kind: 'timeout' },
];

/** 媒体类型预设：用于"附件能力"区块快速添加按钮。 */
const mediaTypePresets: { mime: string; label: string; group: 'image' | 'doc' | 'text' }[] = [
  { mime: 'image/png', label: 'PNG 图片', group: 'image' },
  { mime: 'image/jpeg', label: 'JPG 图片', group: 'image' },
  { mime: 'image/webp', label: 'WebP 图片', group: 'image' },
  { mime: 'image/gif', label: 'GIF 图片', group: 'image' },
  { mime: 'application/pdf', label: 'PDF 文档', group: 'doc' },
  { mime: 'text/plain', label: '纯文本', group: 'text' },
  { mime: 'text/markdown', label: 'Markdown', group: 'text' },
  { mime: 'text/csv', label: 'CSV 表格', group: 'text' },
];

const mediaTypeLabels: Record<string, string> = Object.fromEntries(
  mediaTypePresets.map(preset => [preset.mime, preset.label])
);

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
  const className = `settings-field ${definition.type === 'password' ? 'is-secret' : ''}`;
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
        <span className="settings-reasoning-card-cn">{level.label}</span>
        <span className="settings-reasoning-card-en">{level.english}</span>
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
  const itemSet = new Set(items);
  const [draft, setDraft] = useState('');
  const [bulkMode, setBulkMode] = useState(false);

  const commit = () => {
    const next = draft.trim();
    if (!next || itemSet.has(next)) { setDraft(''); return; }
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

  const togglePreset = (preset: string) => {
    change(itemSet.has(preset)
      ? items.filter(current => current !== preset).join('\n')
      : [...items, preset].join('\n'));
  };

  return <div className="settings-host-list">
    <div className="settings-host-list-head">
      <div className="settings-host-list-head-info">
        <strong>例外地址列表</strong>
        <small>命中这些地址的请求会直接连接，不走代理。支持 IP、CIDR、通配符（*.example.com）。</small>
      </div>
      <span className={`settings-host-list-count ${items.length ? 'is-active' : ''}`}>
        <Icon name="shield" size={11} />
        {items.length} 条
      </span>
    </div>

    <div className="settings-host-list-chips" aria-label="已配置的非代理地址">
      {items.length === 0 && <p className="settings-host-list-empty">
        <Icon name="bulb" size={12} />还没有任何例外地址，代理会对所有请求生效。
      </p>}
      {items.map(item => <span key={item} className="settings-host-chip">
        <Icon name="signal" size={11} />
        <code>{item}</code>
        <button type="button" aria-label={`移除 ${item}`}
          onClick={() => change(items.filter(current => current !== item).join('\n'))}>
          <Icon name="close" size={10} />
        </button>
      </span>)}
    </div>

    <div className="settings-host-list-row">
      <span className="settings-host-list-row-label">
        <Icon name="bolt" size={11} />快速添加
      </span>
      <div className="settings-host-list-presets" role="group" aria-label="快速添加">
        {nonProxyPresets.map(preset => <button key={preset} type="button"
          className={itemSet.has(preset) ? 'selected' : ''}
          onClick={() => togglePreset(preset)}>
          <Icon name={itemSet.has(preset) ? 'check' : 'plus'} size={10} />
          {preset}
        </button>)}
      </div>
    </div>

    {!bulkMode && <div className="settings-host-list-input">
      <span className="settings-host-list-row-label">
        <Icon name="edit" size={11} />自定义
      </span>
      <div className="settings-host-list-input-inner">
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
      <span className="settings-host-list-row-label">
        <Icon name="paste" size={11} />批量模式
      </span>
      <div className="settings-host-list-bulk-inner">
        <textarea value={draft} autoFocus rows={4} placeholder="每行一个地址，匹配 *.example.com / 10.0.0.0/8 等"
          className="settings-control settings-control-textarea"
          onChange={event => setDraft(event.target.value)} />
        <div className="settings-host-list-bulk-actions">
          <button type="button" className="primary-button" onClick={commitBulk}>
            <Icon name="check" size={12} />合并到列表
          </button>
          <button type="button" className="ghost-button" onClick={() => { setBulkMode(false); setDraft(''); }}>
            <Icon name="close" size={12} />取消
          </button>
        </div>
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
  } else if (isPassword) {
    body = <SecretField definition={definition} meta={meta}
      value={value} placeholder={placeholder}
      onChange={next => change(definition.key, next)}
      variant={definition.kind === 'service-secret' ? 'service' : 'managed'} />;
  } else {
    body = <div className="settings-input-wrap">
      <input id={`backend-setting-${definition.key}`}
        type={definition.type ?? 'text'}
        value={value} placeholder={placeholder} className="settings-control"
        onChange={event => change(definition.key, event.target.value)} />
    </div>;
  }

  return <FieldShell definition={definition} meta={meta}>
    {body}
    {definition.help && <p className="settings-field-help">{definition.help}</p>}
  </FieldShell>;
}

/* =============================================================================
 *  SecretField：智能密码框
 *  - 后端已配置且当前为空 → 显示 ***（不暴露真实值）
 *  - 显示/隐藏按钮
 *  - 复制到剪贴板
 *  - 一键生成随机密钥（默认 48 字符 URL-safe base64）
 * ===========================================================================*/
function randomSecret(bytes = 36): string {
  const buf = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  // URL-safe base64
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type SecretVariant = 'service' | 'managed';

/** 外部传入的 API Key / Token：仅提供查看眼睛，禁止复制 / 随机生成 / 恢复默认。 */
function ServiceSecretField({ definition, value, placeholder, onChange }: {
  definition: FieldDefinition;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const inputType = reveal ? 'text' : 'password';
  return <div className="settings-secret-field">
    <div className="settings-input-wrap is-password">
      <input id={`backend-setting-${definition.key}`}
        type={inputType}
        value={value}
        placeholder={placeholder}
        className="settings-control"
        autoComplete="new-password"
        onChange={event => onChange(event.target.value)} />
      <button type="button" className="settings-input-action"
        aria-label={reveal ? '隐藏内容' : '显示内容'} title={reveal ? '隐藏内容' : '显示内容'}
        onClick={() => setReveal(value => !value)}>
        <Icon name={reveal ? 'shield' : 'key'} size={13} />
      </button>
    </div>
  </div>;
}

function SecretField({ definition, meta, value, placeholder, onChange, variant = 'managed' }: {
  definition: FieldDefinition;
  meta?: BundledBackendConfigValue;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  variant?: SecretVariant;
}) {
  if (variant === 'service') {
    return <ServiceSecretField definition={definition} value={value}
      placeholder={placeholder} onChange={onChange} />;
  }
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);

  const serverHasValue = !!meta?.configured;
  const showMasked = serverHasValue && !touched && value === '';
  const displayValue = showMasked ? '' : value;
  // 重要：placeholder 不能写 "•••••"，否则它会跟 .settings-secret-mask 叠在一起。
  const effectivePlaceholder = showMasked ? '后端已配置，留空保留原值' : placeholder;
  const inputType = reveal ? 'text' : 'password';

  const onCopy = async () => {
    if (!displayValue) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(displayValue);
      else {
        const tmp = document.createElement('textarea');
        tmp.value = displayValue; document.body.appendChild(tmp);
        tmp.select(); document.execCommand('copy'); tmp.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const onGenerate = () => {
    const next = randomSecret();
    setTouched(true);
    setReveal(true);
    onChange(next);
  };

  const onClear = () => {
    setTouched(true);
    onChange('');
  };

  return <div className="settings-secret-field">
    <div className="settings-input-wrap is-password">
      <input id={`backend-setting-${definition.key}`}
        type={inputType}
        value={displayValue}
        placeholder={effectivePlaceholder}
        className="settings-control"
        autoComplete="new-password"
        onFocus={() => setTouched(true)}
        onChange={event => { setTouched(true); onChange(event.target.value); }} />
      {showMasked && <span className="settings-secret-mask">••••••••</span>}
      <button type="button" className="settings-input-action"
        aria-label={reveal ? '隐藏内容' : '显示内容'} title={reveal ? '隐藏内容' : '显示内容'}
        onClick={() => setReveal(value => !value)} disabled={showMasked}>
        <Icon name={reveal ? 'shield' : 'key'} size={13} />
      </button>
    </div>
    <div className="settings-secret-toolbar">
      <button type="button" className="ghost-button settings-secret-tool" onClick={onGenerate}
        title="生成一个 URL-safe 随机密钥">
        <Icon name="bolt" size={12} />随机生成
      </button>
      <button type="button" className="ghost-button settings-secret-tool" onClick={onCopy}
        disabled={!displayValue} title="复制当前值">
        <Icon name={copied ? 'check' : 'copy'} size={12} />{copied ? '已复制' : '复制'}
      </button>
      <button type="button" className="ghost-button settings-secret-tool" onClick={onClear}
        disabled={!value && !showMasked} title="清空（恢复为后端已有值）">
        <Icon name="refresh" size={12} />恢复默认
      </button>
    </div>
    <p className="settings-secret-meta">
      {showMasked
        ? <><Icon name="shield" size={11} />后端已有密钥，留空表示保留</>
        : serverHasValue
          ? <><Icon name="edit" size={11} />已修改，保存后写入新值</>
          : <><Icon name="plus" size={11} />尚未配置</>}
    </p>
  </div>;
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

function AddressUrlField({ value, onChange, onSave }: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [hint, setHint] = useState<'idle' | 'success' | 'error' | 'loading'>('idle');

  const handleTest = async () => {
    setError('');
    setResult('');
    setHint('loading');
    setTesting(true);
    let address: string;
    try { address = normalizeBackendUrl(value); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : '地址无效。');
      setHint('error');
      setTesting(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${address}/agent/query_ai_agent_config_list`, { signal: controller.signal });
      if (!response.ok) throw new Error(`后端响应 HTTP ${response.status}。`);
      const body = await response.json() as { code?: string; info?: string };
      if (body.code !== 'SUCCESS_0000') throw new Error(body.info || '后端返回了非成功状态。');
      setResult('连接成功，Agent 接口可用。');
      setHint('success');
    } catch (cause) {
      setError(controller.signal.aborted ? '连接超时，请检查地址和网络。'
        : cause instanceof Error ? cause.message : '连接测试失败。');
      setHint('error');
    } finally {
      clearTimeout(timeout);
      setTesting(false);
    }
  };

  const handleSave = () => {
    setError('');
    setResult('');
    try {
      onSave();
      setResult('客户端访问地址已保存。');
      setHint('success');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存后端地址失败。');
      setHint('error');
    }
  };

  return <div className="settings-address-grid">
    <div className="settings-field settings-address-field">
      <div className="settings-field-head">
        <label htmlFor="backend-setting-server-url">后端服务器根地址</label>
      </div>
      <div className="settings-input-wrap">
        <input id="backend-setting-server-url" type="url" value={value}
          placeholder="http://127.0.0.1:8888" className="settings-control"
          onChange={event => onChange(event.target.value)} />
      </div>
      <div className="settings-address-actions">
        <button type="button" className="ghost-button" disabled={testing} onClick={handleTest}>
          <Icon name="signal" size={12} />{testing ? '测试中…' : '测试连接'}
        </button>
        <button type="button" className="primary-button" onClick={handleSave}>
          <Icon name="check" size={12} />保存地址
        </button>
      </div>
      <p className="settings-field-help">保存后立即生效，重启仍会保留。</p>
    </div>

    <div className={`settings-field settings-address-status is-${hint}`}
      role={hint === 'error' ? 'alert' : 'status'} aria-live="polite">
      <div className="settings-field-head">
        <label>连接状态</label>
        <span className={`settings-address-status-dot is-${hint}`}>
          <i />
        </span>
      </div>
      {hint === 'loading' ? (
        <>
          <p className="settings-address-status-title">正在测试连接…</p>
          <p className="settings-address-status-desc">向 {value || 'http://127.0.0.1:8888'} 发送健康检查请求。</p>
          <div className="settings-address-progress"><span /></div>
        </>
      ) : hint === 'error' ? (
        <>
          <p className="settings-address-status-title">连接失败</p>
          <p className="settings-address-status-desc">{error}</p>
          <p className="settings-address-status-hint">
            <Icon name="alert" size={11} />请检查地址、端口、网络与防火墙。
          </p>
        </>
      ) : hint === 'success' ? (
        <>
          <p className="settings-address-status-title">{result.includes('已保存') ? '地址已保存' : '连接成功'}</p>
          <p className="settings-address-status-desc">{result}</p>
          <p className="settings-address-status-hint">
            <Icon name="shield" size={11} />Agent 接口可用，可安全保存。
          </p>
        </>
      ) : (
        <>
          <p className="settings-address-status-title">尚未测试</p>
          <p className="settings-address-status-desc">点击左侧「测试连接」可快速验证后端是否可达。</p>
          <p className="settings-address-status-hint">
            <Icon name="book" size={11} />测试不会修改任何配置，只发起一次只读请求。
          </p>
        </>
      )}
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
  const itemSet = new Set(items);

  const toggle = (mime: string) => {
    const next = itemSet.has(mime)
      ? items.filter(current => current !== mime)
      : [...items, mime];
    change(next.join('\n'));
  };

  const commitCustom = () => {
    const next = draft.trim();
    if (!next || itemSet.has(next)) { setAdding(false); setDraft(''); return; }
    change([...items, next].join('\n'));
    setAdding(false); setDraft('');
  };

  const usedGroups = new Set(
    items.map(mime => mediaTypePresets.find(preset => preset.mime === mime)?.group).filter(Boolean) as string[]
  );

  return <div className="settings-media-card">
    <div className="settings-media-head">
      <div>
        <strong>附件能力</strong>
        <small>勾选允许发送给模型的 MIME 类型，未知类型可在下方手动输入。Agent 只会发送列表里的文件。</small>
      </div>
      {!adding && <button type="button" className="settings-chip-button" onClick={() => setAdding(true)}>
        <Icon name="plus" size={12} />自定义类型
      </button>}
    </div>

    <div className="settings-media-groups" role="group" aria-label="附件类型预设">
      {(['image', 'doc', 'text'] as const).map(group => {
        const presets = mediaTypePresets.filter(preset => preset.group === group);
        if (!presets.length) return null;
        return <div key={group} className="settings-media-group">
          <span className="settings-media-group-label">
            <Icon name={group === 'image' ? 'file' : group === 'doc' ? 'book' : 'edit'} size={11} />
            {group === 'image' ? '图片' : group === 'doc' ? '文档' : '文本'}
          </span>
          <div className="settings-media-tiles">
            {presets.map(preset => {
              const checked = itemSet.has(preset.mime);
              return <button key={preset.mime} type="button"
                className={`settings-media-tile is-${preset.group} ${checked ? 'checked' : ''}`}
                aria-pressed={checked}
                onClick={() => toggle(preset.mime)}>
                <span className="settings-media-tile-box" aria-hidden="true">
                  {checked
                    ? <Icon name="check" size={13} />
                    : <Icon name="plus" size={13} />}
                </span>
                <span className="settings-media-tile-body">
                  <b>{preset.label}</b>
                  <small>{preset.mime}</small>
                </span>
              </button>;
            })}
          </div>
        </div>;
      })}
    </div>

    {items.filter(item => !mediaTypeLabels[item]).length > 0 && <div className="settings-media-custom">
      <span className="settings-media-group-label">
        <Icon name="edit" size={11} />自定义
      </span>
      <div className="settings-media-chips">
        {items.filter(item => !mediaTypeLabels[item]).map(item => <span key={item} className="settings-media-chip">
          <span className="settings-media-chip-text">
            <b>{item}</b>
            <small>自定义类型</small>
          </span>
          <button type="button" aria-label={`移除 ${item}`}
            onClick={() => change(items.filter(current => current !== item).join('\n'))}>
            <Icon name="close" size={11} />
          </button>
        </span>)}
      </div>
    </div>}

    {!items.length && <p className="settings-empty">尚未允许任何附件类型</p>}
    {!usedGroups.has('image') && !usedGroups.has('doc') && !usedGroups.has('text') && adding === false &&
      items.length > 0 && <p className="settings-media-hint">
        <Icon name="bulb" size={11} />已添加自定义类型，可继续勾选预设或继续添加。
      </p>}

    {adding && <div className="settings-media-add">
      <input value={draft} autoFocus placeholder="例如：text/plain"
        className="settings-control"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commitCustom(); }
          if (event.key === 'Escape') { setAdding(false); setDraft(''); }
        }} />
      <button type="button" className="primary-button" onClick={commitCustom}>添加</button>
      <button type="button" className="outlined-button" onClick={() => { setAdding(false); setDraft(''); }}>取消</button>
    </div>}
  </div>;
}

type VendorId = 'openai' | 'anthropic' | 'google' | 'ollama';

const vendorCatalog: Array<{
  id: VendorId;
  label: string;
  english: string;
  badge: string;
  pathHint: string;
  available: boolean;
}> = [
  { id: 'openai',    label: 'OpenAI',    english: 'openai-compatible',  badge: 'OPENAI',
    pathHint: 'v1/chat/completions', available: true },
  { id: 'anthropic', label: 'Anthropic', english: 'messages-api',      badge: 'CLAUDE',
    pathHint: 'v1/messages',         available: false },
  { id: 'google',    label: 'Google',    english: 'gemini-api',        badge: 'GEMINI',
    pathHint: 'v1beta/models/{model}:generateContent', available: false },
  { id: 'ollama',    label: 'Ollama',    english: 'native-http',       badge: 'OLLAMA',
    pathHint: 'api/chat',            available: false },
];

function ProtocolCard() {
  const [vendor, setVendor] = useState<VendorId>('openai');
  const active = vendorCatalog.find(item => item.id === vendor) ?? vendorCatalog[0];

  return <div className="settings-protocol-card">
    <div className="settings-protocol-head">
      <span className="settings-protocol-icon"><Icon name="network" size={16} /></span>
      <div>
        <strong>接口协议</strong>
        <small>选择后端厂商，下方路径与默认前缀会跟随切换；当前仅 OpenAI 已开放。</small>
      </div>
    </div>
    <div className="settings-protocol-vendors" role="radiogroup" aria-label="模型厂商">
      {vendorCatalog.map(item => {
        const selected = item.id === vendor;
        return <button key={item.id} type="button" role="radio"
          aria-checked={selected}
          className={`settings-protocol-vendor ${selected ? 'selected' : ''} ${item.available ? '' : 'is-locked'}`}
          onClick={() => item.available && setVendor(item.id)}
          disabled={!item.available}
          title={item.available
            ? `使用 ${item.label} 兼容协议`
            : `${item.label} 协议尚未开放，预览中`}>
          <span className="settings-protocol-vendor-head">
            <strong>{item.label}</strong>
            <em>{item.badge}</em>
          </span>
          <code>{item.english}</code>
          <span className="settings-protocol-vendor-foot">
            {item.available
              ? <><Icon name="check" size={10} />已开放</>
              : <><Icon name="shield" size={10} />预览中 · 回显</>}
            <small>{item.pathHint}</small>
          </span>
        </button>;
      })}
    </div>
    <p className="settings-protocol-note">
      <Icon name="bulb" size={11} />
      当前已选择 <b>{active.label}</b>，对话路径与向量路径会自动使用 <code>{active.pathHint}</code> 默认值。
    </p>
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

/**
 * 右上方自动消失的轻量 tip 气泡：
 * - 显示 5 秒；
 * - 鼠标悬浮暂停（计时与进度条同步暂停，不触发 re-render）；
 * - 重复触发重置计时与动画。
 */
function SettingsTip({ error, result, onClear }: { error: string; result: string; onClear: () => void }) {
  const message = error || result;
  const variant: 'success' | 'error' = error ? 'error' : 'success';
  const duration = 5000;
  // hover/timer 用 ref，避免触发 re-render 把进度条动画打断
  const hoveredRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // message/variant 变化时递增 epoch，触发组件重新挂载（重启动画与计时）
  const [epoch, setEpoch] = useState(0);
  const lastShownRef = useRef({ message, variant });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const armTimer = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      hoveredRef.current = false;
      onClear();
    }, duration);
  };

  useEffect(() => {
    const previous = lastShownRef.current;
    if (!message) {
      clearTimer();
      lastShownRef.current = { message, variant };
      return;
    }
    if (previous.message !== message || previous.variant !== variant) {
      lastShownRef.current = { message, variant };
      hoveredRef.current = false;
      setEpoch(value => value + 1);
      armTimer();
    }
  }, [message, variant, duration]);

  // 卸载时清理遗留 timer
  useEffect(() => () => clearTimer(), []);

  if (!message) return null;

  return <div className={`settings-tip is-${variant}`}
    role={variant === 'error' ? 'alert' : 'status'}
    aria-live="polite"
    key={epoch}
    onMouseEnter={() => {
      hoveredRef.current = true;
      clearTimer();
    }}
    onMouseLeave={() => {
      hoveredRef.current = false;
      armTimer();
    }}>
    <span className="settings-tip-icon">
      <Icon name={variant === 'error' ? 'alert' : 'check'} size={14} />
    </span>
    <div className="settings-tip-body">
      <strong>{variant === 'error' ? '操作失败' : '操作成功'}</strong>
      <span>{message}</span>
    </div>
    <button type="button" className="settings-tip-close" aria-label="关闭通知" onClick={onClear}>
      <Icon name="close" size={11} />
    </button>
    {/* 进度条：纯 CSS animation + animation-play-state，由父容器 :hover 控制暂停 */}
    <span className="settings-tip-progress" aria-hidden="true" />
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
  const [error, setError] = useState('');
  const [tabResult, setTabResult] = useState('');
  // 后端运行状态：轮询 Rust 的 bundled_backend_status，便于顶栏指示器和重启按钮联动
  const [backendStatus, setBackendStatus] = useState<BundledBackendStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

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

  // 轮询后端状态：常规 5 秒一次，重启期间缩短为 1 秒以尽快反映 running/failed
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await readBundledBackendStatus();
        if (!cancelled) setBackendStatus(next);
      } catch {
        // 状态读取失败不影响设置页正常使用，留旧值即可
      }
    };
    void poll();
    const interval = window.setInterval(poll, restarting ? 1000 : 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [restarting]);

  const restartBackend = async () => {
    if (!isTauriRuntime() || restarting) return;
    setError('');
    setTabResult('');
    setRestarting(true);
    try {
      const next = await restartBundledBackend();
      setBackendStatus(next);
      if (next?.status === 'running') {
        const directory = next.logDirectory ? `日志目录：${next.logDirectory}。` : '';
        setTabResult(`内置后端已重启为 running。${directory}查看位置：本页“运行与数据目录 → 运行日志”。`);
      } else if (next?.status === 'failed') {
        const directory = next.logDirectory ? `；日志目录：${next.logDirectory}` : '';
        setError(`${next.message || '内置后端启动失败'}${directory}；查看位置：本页“运行与数据目录 → 运行日志”`);
      } else {
        setTabResult(`内置后端状态：${next?.status ?? '未知'}（${next?.message ?? ''}）`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // 多等一轮再退出高频轮询，避免错过状态切换
      window.setTimeout(() => setRestarting(false), 3000);
    }
  };

  const change = (key: string, value: string) => {
    setValues(current => ({ ...current, [key]: value }));
  };

  const saveAddress = () => {
    onSave(normalizeBackendUrl(url));
  };

  /**
   * 保存单个 tab 的配置：只把该 tab 的 keys 写入 YAML，未提交的字段保留原值。
   * Rust 侧 `save_backend_config` 行为是逐 key 更新，所以这种"按 tab 保存"是天然支持的。
   */
  const saveTab = async (scope: SettingsSection) => {
    const definition = sectionItems.find(item => item.id === scope);
    if (!definition) return;
    const dataDirectoryChanged = definition.id === 'general'
      && values.dataDirectory !== config?.values.dataDirectory?.value;
    setError('');
    setTabResult('');
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
      const restartHint = isTauriRuntime() ? '点击右上角「重启后端」即可按当前配置重新启动。' : '重启客户端后才会生效。';
      const migrationWarning = dataDirectoryChanged
        ? '注意：只修改了 YAML 路径，旧数据库、上传文件和日志不会自动迁移。'
        : '';
      setTabResult(`${definition.label}配置已保存到 YAML。${migrationWarning}${restartHint}`);
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
    setTabResult('');
  };

  const renderFields = (fields: FieldDefinition[]) => {
    if (!config) return null;
    return <div className="settings-fields-grid">
      {fields.map(field => <ConfigField key={field.key} definition={field} values={values} config={config} change={change} />)}
    </div>;
  };

  const status = deriveStatus(config, loading, error);
  // 把 Rust 端后端运行状态映射到顶部状态点；未拉到状态时退回到配置读取状态
  const backendStatusStatus: DotStatus = restarting || backendStatus?.status === 'starting'
    ? 'loading'
    : backendStatus?.status === 'running' ? 'ok'
    : backendStatus?.status === 'failed' ? 'error'
    : backendStatus?.status === 'stopped' ? 'warn'
    : status;
  const backendStatusLabel = restarting ? '正在重启内置后端…'
    : backendStatus?.status === 'starting' ? '内置后端启动中…'
    : backendStatus?.status === 'running' ? '内置后端已就绪'
    : backendStatus?.status === 'failed' ? `内置后端启动失败：${backendStatus.message}`
    : backendStatus?.status === 'stopped' ? '内置后端未启动'
    : status === 'loading' ? '正在读取配置…'
    : status === 'error' ? '读取失败'
    : status === 'warn' ? '未读取到配置'
    : '内置后端状态未知';
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
        <div className={`settings-topbar-status is-${backendStatusStatus}`}>
          <StatusDot status={backendStatusStatus} />
          <span>{backendStatusLabel}</span>
          {config && <code title={config.activeProfiles.join(', ')}>{config.activeProfiles.join(', ') || '默认 profile'}</code>}
        </div>
        {config && <button type="button" className="ghost-button" onClick={() => void openPath(config.configDirectory)}>
          <Icon name="folder" size={14} />配置目录
        </button>}
        {isTauriRuntime() && <button type="button" className="ghost-button"
          onClick={() => void restartBackend()}
          disabled={restarting}
          aria-busy={restarting}
          title={restarting ? '正在重启内置后端…' : '停止并按当前 YAML 重新启动内置后端'}>
          <Icon name="refresh" size={14} className={restarting ? 'is-spinning' : ''} />
          {restarting ? '重启中…' : '重启后端'}
        </button>}
      </div>
    </header>

    {/* ============================== 主体 ============================== */}
    <div className="settings-body">
      {/* 侧导航 */}
      <aside className="settings-nav" aria-label="设置分类">
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

        <SettingsTip error={error} result={tabResult}
          onClear={() => { setError(''); setTabResult(''); }} />

        {!loading && activeSection === 'general' && <>
          <SettingsGroup title="客户端访问地址"
            description="可连接外部后端，也可以使用安装包内置后端。"
            badge="客户端级">
            <AddressUrlField value={url} onChange={setUrl} onSave={saveAddress} />
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
                hint="后端运行日志目录；出现启动或运行异常时可在这里查看"
                path={childPath(values.dataDirectory, 'logs') || config.logDirectory} />
            </div>
          </SettingsGroup>}
          <TabSaveBar scope="连接" hint="数据目录只修改 YAML，下次启动后生效；旧数据不会自动迁移。"
            saving={saving} dirty={isTabDirty('general')}
            onSave={() => void saveTab('general')} onReset={() => resetTab('general')} />
        </>}

        {!loading && activeSection === 'model' && config && <>
          <SettingsGroup title="模型渠道"
            description="配置后端调用的大模型服务。"
            badge="模型">
            <ProtocolCard />
            <div className="settings-model-pair">
              <div className="settings-model-cell">
                {renderFields(modelBaseFields)}
                {renderFields(modelChatField)}
                {renderFields(modelEmbedField)}
                {renderFields(modelNameField)}
              </div>
              <div className="settings-model-cell">
                {renderFields(modelApiKeyFields)}
                {renderFields([{ key: 'aiReasoningEffort', label: '推理强度', kind: 'reasoning' }])}
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup title="附件能力"
            description="Agent 可发送给模型的文件类型。"
            badge="附件">
            <MediaTypeEditor value={values.aiSupportedMediaTypes ?? ''}
              change={value => change('aiSupportedMediaTypes', value)} />
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
            <div className="settings-proxy-pair">
              {renderFields([aiProxyFields[0]])}
              {renderFields([aiProxyFields[1]])}
            </div>
            <ConfigField definition={aiProxyFields[2]} values={values} config={config} change={change} />
          </SettingsGroup>
          <SettingsGroup title="SSH HTTP 代理"
            description="用于 SSH 连接需要经过 HTTP 代理服务器的场景。"
            badge="HTTP">
            <BooleanConfigField settingKey="sshProxyEnabled" label="启用 SSH HTTP 代理"
              values={values} config={config} change={change} />
            <div className="settings-proxy-pair">
              {renderFields([sshProxyFields[0]])}
              {renderFields([sshProxyFields[1]])}
            </div>
            <div className="settings-proxy-pair-equal">
              {renderFields([sshProxyFields[2]])}
              {renderFields([sshProxyFields[3]])}
            </div>
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
      </section>
    </div>
  </main>;
}
