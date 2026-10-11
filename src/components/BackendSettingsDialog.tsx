import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  readBundledBackendConfig,
  readBundledBackendAutoStart,
  watchBundledBackendStatus,
  resolveBundledBackendUrl,
  restartBundledBackend,
  stopBundledBackend,
  saveBundledBackendConfig,
  setBundledBackendAutoStart,
  type BundledBackendConfig,
  type BundledBackendConfigValue,
  type BundledBackendStatus,
} from '../api/bundledBackend';
import { type BackendHealthSnapshot } from '../api/health';
import { sftpApi, type LocalDirectory } from '../api/sftp';
import { adoptBundledBackendUrl } from '../config/backend';
import { BackendConnectionSettings } from './BackendConnectionSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { ClientUpdateSettings } from './ClientUpdateSettings';
import { HEALTH_NORMAL_INTERVALS, HEALTH_RETRY_INTERVALS, readHealthRefreshPreferences, saveHealthRefreshPreferences, type HealthRefreshPreferences } from '../config/health';
import { isTauriRuntime } from '../state/runtime';
import { useBackendHealth } from '../state/useBackendHealth';
import { Badge, Icon, Toggle, fileTone, toneForIcon, type AccentTone, type IconName } from './Ui';
import { Select } from './Select';
import { dragAppWindow } from '../state/appWindow';
import { WindowControls } from './WindowControls';
import './BackendSettingsDialog.css';

/* ============================================================================
 * 类型定义
 * ========================================================================== */

type BackendSettingsDialogProps = {
  currentUrl: string;
  required?: boolean;
  onClose: () => void;
  onSave: (url: string) => void;
  beforeClientUpdate?: () => Promise<void>;
  showUpdates?: boolean;
};

type SettingsSection = 'general' | 'appearance' | 'model' | 'proxy' | 'storage' | 'about';
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
  icon: 'settings' | 'monitor' | 'bot' | 'network' | 'database';
  /** 该 tab 涉及的配置 key，用于"按 tab 保存"和 dirty 判断 */
  keys: readonly string[];
  /** 底栏保存按钮文案，例如"保存连接配置" */
  saveLabel: string;
  /** 底栏的配置生效说明 */
  saveHint: string;
};

/* ============================================================================
 * 静态元数据：所有字段都声明式定义
 * ========================================================================== */

/** 按 tab 划分。每个 tab 仅在保存时把对应 keys 写入 YAML，未提交的字段保留原值。 */
const GENERAL_KEYS = ['serverPort', 'dataDirectory', 'serverSslAutoGenerate',
  'serverHttp2Enabled', 'serverSslKeyStore', 'serverSslKeyStoreType', 'serverSslKeyStorePassword', 'serverSslKeyAlias'] as const;
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

/** Rust 侧保留的内部字段，前端不写回。 */
const RESERVED_KEYS = new Set(['localStorageId', 'minioStorageId', 'localRootDirectory']);

const sectionItems: SectionDefinition[] = [
  { id: 'general', label: '连接', caption: '地址 · 端口 · 数据目录', icon: 'settings',
    keys: GENERAL_KEYS,
    saveLabel: '保存内置后端配置', saveHint: '保存不会切换当前连接；重启内置后端后生效。远程连接在上方单独保存。' },
  // 外观是客户端偏好，不加入后端 YAML 白名单，也不显示后端配置保存底栏。
  { id: 'appearance', label: '外观', caption: '自定义壁纸 · 背景透明度', icon: 'monitor',
    keys: [], saveLabel: '', saveHint: '仅保存在客户端，实时生效。' },
  { id: 'model', label: '模型', caption: '渠道 · 协议 · 附件', icon: 'bot',
    keys: MODEL_KEYS,
    saveLabel: '保存模型配置', saveHint: '保存后需重启后端以应用配置；模型密钥留空表示保留现有值。' },
  { id: 'proxy', label: '代理', caption: 'AI 与 SSH HTTP 代理', icon: 'network',
    keys: PROXY_KEYS,
    saveLabel: '保存代理配置', saveHint: '新连接会使用新代理规则；已有 SSH 连接仍按原配置保持。' },
  { id: 'storage', label: '存储', caption: '本地与对象存储', icon: 'database',
    keys: STORAGE_KEYS,
    saveLabel: '保存存储配置', saveHint: '新上传会按新存储设置生效；已有上传不会迁移。' },
  { id: 'about', label: '关于与更新', caption: '版本 · 更新日志 · 安装', icon: 'monitor',
    keys: [], saveLabel: '', saveHint: '仅更新客户端，不修改远程后端。' },
];

const generalFields: FieldDefinition[] = [
  { key: 'serverPort', label: '后端运行端口', kind: 'port', placeholder: '8888', badge: 'TCP' ,
    help: '后端 TCP 服务监听端口，修改后重启服务生效。'
  },
  { key: 'dataDirectory', label: '统一数据目录', placeholder: '/var/lib/ai-ssh-terminal',
    help: 'SQLite、上传文件、运行日志、ssl自签证书均生成在该目录下。' },
];

const tlsStoreFields: FieldDefinition[] = [
  { key: 'serverSslKeyStore', label: '本机证书库地址', wide: true, placeholder: 'file:/D:/certs/server.p12',
    help: '仅用于本机内置 Java。文件必须已存在并包含证书链和私钥；远程 /etc/ssl 路径不能填在这里。' },
  { key: 'serverSslKeyStoreType', label: '证书库类型', type: 'choice',
    options: [{ value: 'PKCS12', label: 'PKCS12 (.p12)' }, { value: 'JKS', label: 'JKS' }] },
  { key: 'serverSslKeyStorePassword', label: '证书库密码', type: 'password',
    help: '不会回显。留空保留已有配置；仅保存到本机后端配置，不发送到远程服务器。' },
  { key: 'serverSslKeyAlias', label: '私钥别名（可选）', help: '填写证书库中的实际别名，不能直接照搬默认证书别名。' },
];

const modelFields: FieldDefinition[] = [
  { key: 'aiBaseUrl', label: '模型服务地址', placeholder: 'http://127.0.0.1:8777/', wide: true,
    help: 'OpenAI 兼容服务的根地址，不要附加 /v1/chat/completions。', badge: 'BASE URL' },
  { key: 'aiApiKey', label: 'API Key', type: 'password',
    help: '密钥不会回显。留空表示保留现有值。' },
  { key: 'aiModelName', label: '模型名称', placeholder: 'gpt-5.5', badge: 'MODEL' },
  { key: 'aiCompletionsPath', label: '对话接口路径', kind: 'path-preset',
    pathGroup: 'aiCompletionsPath', placeholder: 'v1/chat/completions',
    help: 'OpenAI 兼容服务通常无需修改。' },
  { key: 'aiEmbeddingsPath', label: '向量接口路径', kind: 'path-preset',
    pathGroup: 'aiEmbeddingsPath', placeholder: 'v1/embeddings',
    help: '只有服务商使用不同路径时才修改。' },
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

/** OpenAI 标准接口路径；选择自定义格式后才允许编辑。 */
const openAiPathPresets: Record<string, { label: string; english: string; path: string }[]> = {
  aiCompletionsPath: [
    { label: 'OpenAI 标准', english: 'v1/chat/completions',     path: 'v1/chat/completions' },
  ],
  aiEmbeddingsPath: [
    { label: 'OpenAI 标准', english: 'v1/embeddings',            path: 'v1/embeddings' },
  ],
};



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

/** 把 /api/health 结果收敛成顶栏能直接展示的语义状态。 */
type HealthState = 'idle' | 'probing' | 'up' | 'down' | 'error';
function deriveHealthState(snapshot: BackendHealthSnapshot | null, probing: boolean, error: string): HealthState {
  if (probing) return 'probing';
  if (error) return 'error';
  if (!snapshot) return 'idle';
  return snapshot.ok ? 'up' : 'down';
}

function healthLabel(state: HealthState, snapshot: BackendHealthSnapshot | null): string {
  if (state === 'probing') return '健康检查中…';
  if (state === 'idle') return '尚未做健康检查';
  if (state === 'up') return snapshot?.latencyMs != null ? `服务正常 · ${snapshot.latencyMs}ms` : '服务正常';
  if (state === 'down') return '后端未就绪';
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
  return <Badge className="settings-field-badge" icon="settings">由系统管理</Badge>;
}

function healthAccentTone(state: HealthState): AccentTone {
  return state === 'up' ? 'success' : state === 'down' ? 'danger' : state === 'error' ? 'amber' : state === 'probing' ? 'blue' : 'neutral';
}

const settingsBadgeIcons: Record<string, IconName> = {
  MODEL: 'bot', 模型: 'bot', 附件: 'attach', 存储: 'box', BUCKET: 'box', REGION: 'server',
  'BASE URL': 'network', HOST: 'network', 'PUBLIC URL': 'network', PUBLIC: 'network', ENDPOINT: 'network',
  TCP: 'bolt', 启动: 'power', 运行时: 'disk', 客户端级: 'monitor', 健康检查: 'signal',
};

function SettingsBadge({ label, className }: { label: string; className: string }) {
  const icon = settingsBadgeIcons[label] ?? 'settings';
  return <Badge className={className} tone={toneForIcon(icon)} icon={icon}>{label}</Badge>;
}

/** 附件与代理地址共用模型模块现有标签的结构和样式。 */
function SettingsTag({ label, detail, removeLabel, onRemove, tone = 'cyan', icon = 'network' }: {
  label: string;
  detail?: string;
  removeLabel: string;
  onRemove: () => void;
  tone?: AccentTone;
  icon?: IconName;
}) {
  return <span className="settings-media-chip" data-accent={tone}>
    <Icon name={icon} size={13} />
    <span className="settings-media-chip-text">
      <b>{label}</b>
      {detail && <small>{detail}</small>}
    </span>
    <button type="button" aria-label={removeLabel} onClick={onRemove}>
      <Icon name="close" size={11} />
    </button>
  </span>;
}

/**
 * /api/health 探测结果的轻量指示器。
 * 复用 settings-status-dot 的形状，但颜色按 UP / DOWN / probing 区分。
 */
function HealthDot({ state }: { state: HealthState }) {
  return <span className={`settings-status-dot settings-health-dot ${healthToneClass(state)}`} aria-hidden="true"><i /></span>;
}

function BackendHealthCard({ label, address, health, inactiveReason, children }: {
  label: string;
  address: string | null;
  health: ReturnType<typeof useBackendHealth>;
  inactiveReason?: string;
  children?: ReactNode;
}) {
  const inactive = !health.snapshot && !health.probing && !health.error ? inactiveReason : undefined;
  const state = deriveHealthState(health.snapshot, health.probing, health.error);
  const tone = healthAccentTone(state);
  const resultIcon: IconName = state === 'up' ? 'check' : state === 'down' || state === 'error' ? 'alert' : state === 'probing' ? 'refresh' : 'history';
  const hint = (state === 'probing' ? '正在等待服务响应…' : '') || health.error || health.snapshot?.message
    || (inactive ? '可以随时检查配置的服务地址；启动后会继续自动复查。' : '')
    || (state === 'up' ? '服务正常，可以连接。'
      : '可以手动检查，也可以开启自动刷新。');
  return <div className="settings-health-card">
    <div className="settings-health-card-row">
      <Badge tone={label === '内置服务' ? 'violet' : 'cyan'} icon={label === '内置服务' ? 'server' : 'network'}>{label}</Badge>
      <Badge tone={tone} icon={resultIcon} className="settings-health-state">{inactive || healthLabel(state, health.snapshot)}</Badge>
      {address && <code title={address}>{address}</code>}
      <button type="button" className="settings-secondary-button" aria-busy={health.probing}
        onClick={() => { void health.probe(); }}>
        <Icon name="refresh" size={12} />{health.probing ? '检查中…' : `检查${label}`}
      </button>
    </div>
    <div className="settings-health-result" data-accent={tone} role="status" aria-live="polite">
      <Icon name={resultIcon} size={16} />
      <div><p className="settings-health-card-hint">{hint}</p>
        {health.snapshot?.checkedAt && <small className="settings-health-card-time" aria-live="off">
          <Icon name="history" size={12} />上次检查：{new Date(health.snapshot.checkedAt).toLocaleString()}
        </small>}
      </div>
    </div>
    {children && <div className="settings-health-address">{children}</div>}
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
        {meta?.sensitive && <Badge tone="amber" icon="shield" className="settings-field-secret">敏感</Badge>}
        {definition.badge && <SettingsBadge className="settings-field-badge" label={definition.badge} />}
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

function PortInput({ value, change }: {
  value: string;
  change: (next: string) => void;
}) {
  return <div className="settings-port-picker">
    <div className="settings-input-wrap">
      <input id="backend-setting-serverPort" type="number" value={value} placeholder="8888"
        className="settings-control" min={1} max={65535}
        onChange={event => change(event.target.value)} />
      <span className="settings-input-suffix">TCP</span>
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
  const standardPath = presets[0]?.path ?? '';
  const [customSelected, setCustomSelected] = useState(() => value !== standardPath);
  const customDraft = useRef(value);
  const locallyAppliedValue = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (locallyAppliedValue.current === value) return;
    locallyAppliedValue.current = value;
    customDraft.current = value;
    setCustomSelected(value !== standardPath);
  }, [value, standardPath]);
  return <div className="settings-path-preset">
    <div className="settings-input-wrap">
      <input ref={inputRef} id={`backend-setting-${group}`} type="text" value={value}
        readOnly={!customSelected} placeholder={standardPath} className="settings-control settings-control-mono"
        title={customSelected ? '自定义接口路径' : '标准路径，选择“自定义格式”后可编辑'}
        onChange={event => {
          if (!customSelected) return;
          customDraft.current = event.target.value;
          locallyAppliedValue.current = event.target.value;
          change(event.target.value);
        }} />
      {meta?.configured && value && <span className="settings-input-suffix">
        <Icon name="check" size={11} />
      </span>}
    </div>
    <div className="settings-path-preset-list settings-path-format-options" role="group" aria-label="接口路径格式">
      {presets.map(preset => <button key={preset.label} type="button"
        className={!customSelected ? 'selected' : ''} aria-pressed={!customSelected}
        onClick={() => {
          if (customSelected) customDraft.current = value;
          setCustomSelected(false);
          locallyAppliedValue.current = preset.path;
          change(preset.path);
        }}>
        <strong>{preset.label}</strong>
        <code>{preset.english}</code>
      </button>)}
      <button type="button" className={customSelected ? 'selected' : ''} aria-pressed={customSelected}
        onClick={() => {
          if (!customSelected) {
            locallyAppliedValue.current = customDraft.current;
            change(customDraft.current);
          }
          setCustomSelected(true);
          inputRef.current?.focus();
        }}>
        <strong>自定义格式</strong>
        <small>手动填写接口路径</small>
      </button>
    </div>
  </div>;
}

function TimeoutPresetGrid({ settingKey, value, change, presets }: {
  settingKey: string;
  value: string;
  change: (next: string) => void;
  presets: { value: string; label: string; english: string; description: string }[];
}) {
  return <div className="settings-path-preset">
    <input id={`backend-setting-${settingKey}`} value={value}
      className="settings-control" placeholder="例如：30s 或 2m"
      onChange={event => change(event.target.value)} />
    <div className="settings-path-preset-list" role="group" aria-label="超时档位">
      {presets.map(preset => <button key={preset.value} type="button"
        aria-pressed={value === preset.value}
        className={value === preset.value ? 'selected' : ''}
        title={preset.description} onClick={() => change(preset.value)}>
        <strong>{preset.label}</strong>
        <code>{preset.english}</code>
      </button>)}
    </div>
  </div>;
}

/** 复用现有本地目录接口，不依赖后端运行状态或新增原生命令。 */
function DataDirectoryPicker({ value, change }: { value: string; change: (next: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { requestRef.current += 1; }, []);

  const browse = async (target?: string, fallback = false) => {
    const request = ++requestRef.current;
    setBusy(true);
    setError('');
    try {
      let next: LocalDirectory;
      try { next = await sftpApi.local(target); }
      catch (cause) {
        if (!fallback || !target || request !== requestRef.current) throw cause;
        next = await sftpApi.local();
      }
      if (request === requestRef.current) setDirectory(next);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : '无法读取目录。');
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };

  const close = () => {
    requestRef.current += 1;
    setBrowsing(false);
    setBusy(false);
    setError('');
    setDirectory(null);
    pickerButtonRef.current?.focus();
  };

  const folders = directory?.entries.filter(entry => entry.kind === 'DIRECTORY') ?? [];
  return <div className="settings-directory-picker">
    <div className="settings-directory-input">
      <input id="backend-setting-dataDirectory" value={value} className="settings-control"
        placeholder="输入数据目录的绝对路径" onChange={event => change(event.target.value)} />
      <button ref={pickerButtonRef} type="button" className="settings-secondary-button" aria-expanded={browsing}
        aria-controls="settings-directory-browser" onClick={() => {
          if (browsing) { close(); return; }
          setBrowsing(true);
          void browse(value.trim() || undefined, true);
        }}>
        <Icon name="folder" size={13} />选择目录
      </button>
    </div>
    {browsing && <div id="settings-directory-browser" className="settings-directory-browser" aria-busy={busy}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
      {!!directory?.roots.length && <div className="settings-segmented" role="group" aria-label="磁盘位置">
        {directory.roots.map(root => <button key={root} type="button" disabled={busy}
          aria-pressed={directory.path.startsWith(root)}
          className={directory.path.startsWith(root) ? 'selected' : ''}
          onClick={() => void browse(root)}>{root}</button>)}
      </div>}
      <div className="settings-directory-toolbar">
        <button type="button" className="ghost-button" disabled={busy || !directory?.parent}
          onClick={() => { if (directory?.parent) void browse(directory.parent); }}>
          <Icon name="up" size={12} />上一级
        </button>
        <span title={directory?.path}>{directory?.path || '正在读取目录…'}</span>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <ul className="settings-directory-list" aria-label="子目录">
        {folders.map(folder => <li key={folder.path}>
          <button type="button" disabled={busy} onClick={() => void browse(folder.path)}>
            <Icon name="folder" size={13} /><span>{folder.name}</span><Icon name="right" size={12} />
          </button>
        </li>)}
      </ul>
      {!busy && directory && !folders.length && <p className="settings-empty">此目录没有子目录，可直接选择。</p>}
      <div className="settings-directory-actions">
        <button type="button" className="ghost-button" onClick={close}>取消</button>
        <button type="button" className="primary-button" disabled={busy || !directory || !!error}
          onClick={() => { if (directory) { change(directory.path); close(); } }}>使用此目录</button>
      </div>
    </div>}
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
    <div className="settings-media-chips" aria-label="已配置的非代理地址">
      {items.length === 0 && <p className="settings-empty">还没有任何例外地址，代理会对所有请求生效</p>}
      {items.map(item => <SettingsTag key={item} label={item} removeLabel={`移除 ${item}`}
        onRemove={() => change(items.filter(current => current !== item).join('\n'))} />)}
    </div>
    {!bulkMode && <div className="settings-host-list-add">
      <div className="settings-host-list-presets" role="group" aria-label="快速添加">
        {nonProxyPresets.map(preset => <button key={preset} type="button"
          className={`settings-chip-button ${items.includes(preset) ? 'selected' : ''}`}
          aria-pressed={items.includes(preset)}
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
        <input id="backend-setting-aiNonProxyHosts" value={draft} placeholder="输入自定义地址或通配模式，如 *.internal"
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
      <textarea id="backend-setting-aiNonProxyHosts" value={draft} autoFocus rows={4} placeholder="每行一个地址，匹配 *.example.com / 10.0.0.0/8 等"
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

  if (definition.key === 'dataDirectory') {
    return <FieldShell definition={definition} meta={meta}>
      <DataDirectoryPicker value={value} change={next => change(definition.key, next)} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }

  // 1) 自定义 kind 渲染器
  if (definition.kind === 'reasoning') {
    return <FieldShell definition={definition} meta={meta}>
      <ReasoningEffortGrid value={value} change={next => change(definition.key, next)} />
      {definition.help && <p className="settings-field-help">{definition.help}</p>}
    </FieldShell>;
  }
  if (definition.kind === 'port') {
    return <FieldShell definition={definition} meta={meta}>
      <PortInput value={value} change={next => change(definition.key, next)} />
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
        <TimeoutPresetGrid settingKey={definition.key} value={value} change={next => change(definition.key, next)}
          presets={timeoutPresets[timeoutKey]} />
        <p className="settings-field-help">可选常用时长，也可输入自定义值；s 表示秒，m 表示分钟。</p>
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
  return <div className="settings-toggle-row">
    <span className="settings-toggle-state">{label}</span>
    <Toggle label={label} value={enabled} onChange={value => change(settingKey, String(value))} />
    <span className="settings-field-help">{enabled ? '已开启' : '已关闭'}</span>
    <ConfigSource meta={meta} />
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
      {items.map(item => <SettingsTag key={item} label={mediaTypeLabels[item] ?? item}
        tone={fileTone(item)} icon="file"
        detail={mediaTypeLabels[item] ? item : '自定义类型'}
        removeLabel={`移除 ${mediaTypeLabels[item] ?? item}`}
        onRemove={() => change(items.filter(current => current !== item).join('\n'))} />)}
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
    <div className="settings-protocol-options" role="radiogroup" aria-label="模型接口协议">
      {([
        { value: 'openai', label: 'OpenAI 兼容' },
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'google', label: 'Google' },
      ] as const).map(option => {
        const selected = option.value === protocol;
        return <button key={option.value} type="button" role="radio" aria-checked={selected}
          disabled={option.value !== 'openai'}
          className={`settings-storage-card settings-protocol-option ${selected ? 'selected' : ''}`}
          onClick={() => setProtocol('openai')}>
          <span className="settings-storage-body">
            <strong>{option.label}</strong>
            <small>{selected ? '已选择' : '暂未支持'}</small>
          </span>
          <Icon name={selected ? 'check' : 'shield'} size={14} />
        </button>;
      })}
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

  return <div className="settings-storage-mode">
    <div className="settings-storage-options" role="radiogroup" aria-label="文件存储方式">
      {([
        { mode: 'local', label: '本地存储', description: '文件保存在当前电脑，适合桌面使用', icon: 'folder' },
        { mode: 'minio', label: 'MinIO', description: '文件保存在独立对象存储服务器', icon: 'server' },
      ] as const).map(option => <button key={option.mode} type="button" role="radio"
        aria-checked={activeMode === option.mode}
        className={`settings-storage-card ${activeMode === option.mode ? 'selected' : ''}`}
        onClick={() => selectMode(option.mode)}>
        <span className="settings-storage-icon"><Icon name={option.icon} size={16} /></span>
        <span className="settings-storage-body">
          <strong>{option.label}</strong>
          <small>{option.description}</small>
        </span>
        <span className="settings-storage-check" aria-hidden="true">
          {activeMode === option.mode && <Icon name="check" size={14} />}
        </span>
      </button>)}
    </div>
    <ConfigSource meta={config.values.fileStorageDefaultId} />
    {((activeMode === 'local' && !localEnabled) || (activeMode === 'minio' && !minioEnabled)) &&
      <p className="settings-storage-warning">
        <Icon name="alert" size={12} />
        当前选择的存储尚未启用，上传会失败。请开启它或选择另一种存储。
      </p>}
  </div>;
}

function TabSaveBar({ scope, saveLabel, hint, saving, dirty, onSave, onReset }: {
  scope: string;
  saveLabel: string;
  hint: string;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return <div className="settings-tab-save" data-scope={scope}>
    <div className="settings-tab-save-meta">
      <strong>
        <Icon name={dirty ? 'edit' : 'check'} size={12} />
        {scope === 'general'
          ? saving ? '正在保存内置后端配置…' : dirty ? '内置后端配置有未保存修改' : '内置后端配置暂无未保存修改'
          : saving ? '正在保存配置…' : dirty ? '有未保存的修改' : '暂无未保存修改'}
      </strong>
      <span>{hint}</span>
    </div>
    <div className="settings-tab-save-actions">
      <button type="button" className="ghost-button" disabled={saving || !dirty} onClick={onReset}>
        <Icon name="history" size={12} />重置
      </button>
      <button type="button" className="primary-button" disabled={saving || !dirty} onClick={onSave}>
        <Icon name="check" size={12} />{saving ? '保存中…' : saveLabel}
      </button>
    </div>
  </div>;
}

function SettingsGroup({ id, title, description, badge, action, expanded, children }: {
  id?: string;
  title: string;
  description?: string;
  badge?: string;
  action?: ReactNode;
  expanded?: boolean;
  children: ReactNode;
}) {
  return <section id={id} className={`settings-group${expanded !== undefined ? ' is-collapsible' : ''}`} aria-label={title}>
    <header>
      <div>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {action ? <div className="settings-group-actions">{action}</div>
        : badge && <SettingsBadge className="settings-group-badge" label={badge} />}
    </header>
    {expanded === undefined ? <div className="settings-group-body">{children}</div>
      : <div className="settings-disclosure" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
        <div className="settings-disclosure-inner">
          <div className="settings-group-body">{children}</div>
        </div>
      </div>}
  </section>;
}

function PathPreviewCard({ label, icon, path, hint }: {
  label: string;
  icon: 'folder' | 'disk' | 'file';
  path?: string;
  hint?: string;
}) {
  return <div className="settings-path-preview" data-accent={toneForIcon(icon)}>
    <span><Icon name={icon} size={14} />{label}</span>
    <code title={path}>{path ? collapsePath(path, 72) : '—'}</code>
    {hint && <small>{hint}</small>}
  </div>;
}

/* ============================================================================
 * 主组件
 * ========================================================================== */

export function BackendSettingsDialog({ currentUrl, required = false, onClose, onSave, beforeClientUpdate, showUpdates = false }: BackendSettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(showUpdates ? 'about' : 'general');
  useEffect(() => { if (showUpdates) setActiveSection('about'); }, [showUpdates]);
  const [config, setConfig] = useState<BundledBackendConfig | null>(null);
  const [values, setValues] = useState<ConfigValues>({});
  const [pathResetVersion, setPathResetVersion] = useState(0);
  const [loading, setLoading] = useState(isTauriRuntime());
  const [saving, setSaving] = useState(false);
  const [openingConfigDirectory, setOpeningConfigDirectory] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
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
   * 当前内置后端进程状态，用来切换启动/停止按钮，并在状态变化时刷新健康检查。
   * HTTP 服务是否就绪仍以 /api/health 的结果为准。
   */
  const [backendStatus, setBackendStatus] = useState<BundledBackendStatus | null>(null);
  const backendStatusRevision = useRef(-1);
  /** 事件与启停命令返回共用版本检查，避免旧命令结果覆盖较新的退出/重启通知。 */
  const updateBackendStatus = useCallback((next: BundledBackendStatus | null) => {
    if (next && next.revision < backendStatusRevision.current) return false;
    if (next) backendStatusRevision.current = next.revision;
    setBackendStatus(previous => previous && next && previous.revision >= next.revision ? previous : next);
    return true;
  }, []);
  const [healthRefresh, setHealthRefresh] = useState(readHealthRefreshPreferences);
  const [healthRefreshError, setHealthRefreshError] = useState('');
  const updateHealthRefresh = (patch: Partial<HealthRefreshPreferences>) => {
    const next = { ...healthRefresh, ...patch };
    try {
      saveHealthRefreshPreferences(next);
      setHealthRefresh(next);
      setHealthRefreshError('');
    } catch (cause) {
      setHealthRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const currentHealth = useBackendHealth(currentUrl, backendStatus?.status, true, healthRefresh);
  const { snapshot: healthSnapshot, probing: healthProbing, error: healthError, probe: runHealthProbe } = currentHealth;
  const bundledUrl = resolveBundledBackendUrl(backendStatus, config);
  const bundledHealth = useBackendHealth(bundledUrl, backendStatus?.status, isTauriRuntime(), healthRefresh);
  const bundledInactiveReason = backendStatus?.status === 'stopped' ? '内置服务未启动'
    : backendStatus?.status === 'failed' ? '内置服务启动失败，请查看启动提示'
    : !backendStatus ? '正在读取内置服务状态…' : undefined;
  const [healthDetailsRequested, setHealthDetailsRequested] = useState(false);

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

  /** 首次读取快照，之后只接收状态变更；关闭设置时自动取消监听。 */
  useEffect(() => {
    if (!isTauriRuntime()) return;
    return watchBundledBackendStatus(updateBackendStatus, () => {
      if (backendStatusRevision.current < 0) setBackendStatus(null);
    });
  }, [updateBackendStatus]);

  /** 顶部入口在切换到连接分区并完成渲染后，定位到健康检查模块。 */
  useEffect(() => {
    if (!healthDetailsRequested || activeSection !== 'general' || loading) return;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    document.getElementById('settings-health-check')?.scrollIntoView({ behavior, block: 'start' });
    setHealthDetailsRequested(false);
  }, [healthDetailsRequested, activeSection, loading]);

  const openConfigDirectory = async () => {
    if (!config || openingConfigDirectory) return;
    setOpeningConfigDirectory(true);
    setError('');
    try {
      // 默认 opener 权限允许定位文件；打开其所在目录并选中主配置文件。
      await revealItemInDir(config.applicationFile);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`无法打开配置目录：${message}`);
    } finally {
      setOpeningConfigDirectory(false);
    }
  };

  /**
   * 切换自动启动。注意：开关本身只描述“客户端启动时是否自动拉起后端”，
   * 它的生效时机是下一次打开客户端；切换当下不立即拉/停 Java。
   * 开关不会立即启停当前 Java；要立即操作请点击“启动/停止内置服务”。
   */
  const toggleAutoStart = async () => {
    setAutoStartError('');
    const next = !autoStartEnabled;
    setAutoStartEnabled(next);
    setSettingsStarting(false);
    try {
      const confirmed = await setBundledBackendAutoStart(next);
      if (confirmed !== null) setAutoStartEnabled(confirmed);
      // 仅保存下次启动偏好，当前进程状态未变化，不额外查询或伪造状态。
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
      // 命令返回前若已收到更新的失败/重启通知，不能再显示旧成功信息或同步旧地址。
      if (!updateBackendStatus(status)) return;
      if (status?.status === 'running') {
        // 配置页重启也同步真实协议，不能只更新启动页的健康检查地址。
        const selected = adoptBundledBackendUrl(status.backendUrl);
        if (selected !== currentUrl) {
          onSave(selected);
        }
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
      if (!updateBackendStatus(status)) return;
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

  /**
   * 保存单个 tab 的配置：只把该 tab 的 keys 写入 YAML，未提交的字段保留原值。
   * Rust 侧 `save_backend_config` 行为是逐 key 更新，所以这种"按 tab 保存"是天然支持的。
   */
  const saveTab = async (scope: SettingsSection) => {
    // 无修改或正在保存时不发起 YAML 写入，与保存栏的禁用条件保持一致。
    if (saving || !isTabDirty(scope)) return;
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
        if (values.serverSslAutoGenerate !== 'true'
            && !values.serverSslKeyStore?.trim()) throw new Error('自定义证书模式需要填写本机证书库地址。');
      }
      const editableValues: Record<string, string> = {};
      for (const key of definition.keys) {
        if (RESERVED_KEYS.has(key)) continue;
        if (!(key in values)) continue;
        editableValues[key] = values[key] ?? '';
      }
      if (definition.id === 'general' && values.serverSslAutoGenerate === 'true') {
        // 保留动态数据目录引用，不能把页面展示的绝对路径写死；切换数据目录后默认证书跟随。
        editableValues.serverSslKeyStore = 'file:${app.config.data-directory}/tls/local-backend.p12';
      }
      const saved = await saveBundledBackendConfig({ values: editableValues });
      if (saved) {
        setConfig(saved);
        setValues(Object.fromEntries(Object.entries(saved.values).map(([key, meta]) => [key, meta.value])));
      }
      setResult(definition.id === 'general'
        ? '内置后端配置已保存，当前连接未改变；未保存或应用上方客户端连接。内置后端不会自动重启。'
        : `${definition.label}配置已保存，内置后端不会自动重启。`);
      // 保存本地配置不代表切换连接；运行中的服务地址仍以状态为准，重启后再同步。
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
    if (scope === 'model') setPathResetVersion(previous => previous + 1);
    setError('');
    setResult('');
  };

  const renderFields = (fields: FieldDefinition[]) => {
    if (!config) return null;
    return <div className="settings-fields-grid">
      {fields.map(field => <ConfigField key={`${field.key}:${field.kind === 'path-preset' ? pathResetVersion : 0}`}
        definition={field} values={values} config={config} change={change} />)}
    </div>;
  };

  const healthState = deriveHealthState(healthSnapshot, healthProbing, healthError);
  const healthLabelText = healthLabel(healthState, healthSnapshot);
  const bundledHealthState = deriveHealthState(bundledHealth.snapshot, bundledHealth.probing, bundledHealth.error);
  const bundledHealthLabel = bundledHealthState !== 'idle' ? healthLabel(bundledHealthState, bundledHealth.snapshot)
    : backendStatus?.status === 'stopped' ? '未启动' : backendStatus?.status === 'failed' ? '启动失败'
    : !backendStatus ? '读取状态中…' : healthLabel(bundledHealthState, bundledHealth.snapshot);
  const activeStorageMode = values.fileStorageDefaultId === (values.minioStorageId || 'minio-main') ? 'minio' : 'local';
  const activeDefinition = sectionItems.find(item => item.id === activeSection) ?? sectionItems[0];
  const showSaveBar = activeSection !== 'appearance' && activeSection !== 'about' && !loading && (activeSection === 'general' || config !== null);

  return <main className={`settings-page ${required ? 'is-standalone' : ''}`} aria-label="客户端设置">
    {/* ============================== 顶栏 ============================== */}
    <header className="settings-topbar" onMouseDown={required ? dragAppWindow : undefined}>
      <div className="settings-topbar-left">
        {!required && <button type="button" className="settings-back-button" onClick={onClose} aria-label="返回终端">
          <Icon name="left" size={16} />返回
        </button>}
        <div className="settings-topbar-title">
          <h1>客户端与内置后端设置</h1>
          <p>{activeSection === 'appearance' ? '画面预览后保存，透明度实时生效；仅保存在客户端，无需重启。'
            : activeSection === 'about' ? '检查和下载客户端更新，确认后安装并重启；远程后端不会随之更新。'
            : '修改后请保存对应配置；服务不会自动重启，下次启动或手动重启后生效。'}</p>
        </div>
      </div>
      <div className="settings-topbar-right">
        <button
          type="button"
          className={`settings-topbar-status settings-health-pill ${healthToneClass(healthState)}`}
          data-accent={healthAccentTone(healthState)}
          onClick={() => { void runHealthProbe(); }}
          title={healthError || (healthSnapshot
            ? [healthSnapshot.message, `上次检查：${new Date(healthSnapshot.checkedAt).toLocaleString()}`].filter(Boolean).join('\n')
            : '点击重新检查当前后端服务')}
          aria-label="重新检查后端服务"
        >
          <HealthDot state={healthState} />
          <span>当前后端 · {healthLabelText}</span>
        </button>
        {isTauriRuntime() && <button type="button"
          className={`settings-topbar-status settings-health-pill ${healthToneClass(bundledHealthState)}`}
          data-accent={healthAccentTone(bundledHealthState)}
          aria-busy={bundledHealth.probing}
          onClick={() => { void bundledHealth.probe(); }}
          title={bundledHealth.error || bundledHealth.snapshot?.message || '检查内置服务实际监听地址'}
          aria-label="检查内置服务健康状态">
          <HealthDot state={bundledHealthState} />
          <span>内置后端 · {bundledHealthLabel}</span>
        </button>}
        <button type="button" className="ghost-button" onClick={() => {
          setActiveSection('general');
          setHealthDetailsRequested(true);
          void runHealthProbe();
          if (isTauriRuntime()) void bundledHealth.probe();
        }}><Icon name="signal" size={14} />健康检查</button>
        {config && <button type="button" className="ghost-button"
          disabled={openingConfigDirectory} onClick={() => void openConfigDirectory()}
          title="打开配置文件所在文件夹并选中 application.yml">
          <Icon name="folder" size={14} />{openingConfigDirectory ? '正在打开…' : '配置目录'}
        </button>}
        {required && <WindowControls />}
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
            <span className="settings-nav-icon" data-accent={toneForIcon(item.icon)}><Icon name={item.icon} size={17} /></span>
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
          <small>保存时会自动备份现有配置。</small>
        </div>}
      </aside>

      {/* 内容滚动区与保存底栏分别占用布局空间，底栏不覆盖字段。 */}
      <div className="settings-content-panel" data-section={activeSection}>
        <section className="settings-content" data-section={activeSection}>
          {activeSection === 'appearance' && <AppearanceSettings />}
          {activeSection === 'about' && <ClientUpdateSettings beforeInstall={async () => {
            if (saving) throw new Error('配置正在保存，请等待保存完成再安装更新。');
            if (sectionItems.some(item => isTabDirty(item.id))) throw new Error('请先保存或还原设置中的未保存修改。');
            await beforeClientUpdate?.();
          }} />}
          {loading && activeSection !== 'appearance' && activeSection !== 'about' && <div className="settings-skeleton" aria-label="正在读取配置">
            <span style={{ width: '92%' }} />
            <span style={{ width: '74%' }} />
            <span style={{ width: '88%' }} />
            <span style={{ width: '62%' }} />
            <span style={{ width: '80%' }} />
          </div>}

          {!loading && activeSection === 'general' && <div className="settings-columns settings-connections-layout">
            <div className="settings-column" role="group" aria-label="启动、连接与数据设置">
              {autoStartAvailable && <SettingsGroup title="启动方式"
                description="关闭后，客户端不会自动启动内置服务，可在启动页或此处手动启动。"
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
                      : '可在此或启动页点击“启动内置服务”'}
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
                            : '点击手动启动内置服务'));
                  return (
                    <div className="settings-toggle-row">
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
              <SettingsGroup title="客户端连接" description="选择内置后端或保存多个远程连接，各自的证书信任配置互不覆盖。" badge="客户端">
                <BackendConnectionSettings localUrl={bundledUrl} onUse={onSave} />
              </SettingsGroup>
              {config && <SettingsGroup title="基础设置"
                description="仅配置内置服务，保存不切换当前连接；数据目录必须使用绝对路径。"
                badge="运行时">
                {renderFields(generalFields)}

              </SettingsGroup>}
            </div>
            <div className="settings-column" role="group" aria-label="服务健康与安全设置">
            <SettingsGroup id="settings-health-check" title="服务健康检查"
              description="检查实际服务响应；当前后端（含远端）与内置服务共用下方刷新设置。"
              badge="健康检查">
              {isTauriRuntime() && <BackendHealthCard label="内置服务" address={bundledUrl}
                health={bundledHealth} inactiveReason={bundledInactiveReason} />}
              <BackendHealthCard label="当前后端" address={currentUrl} health={currentHealth} />
              <div className="settings-health-preferences">
                <div className="settings-toggle-row">
                  <div><strong>自动刷新</strong><p>设置页打开期间静默检查，修改立即生效并保存在本机。</p></div>
                  <Toggle value={healthRefresh.enabled} onChange={enabled => updateHealthRefresh({ enabled })} label="自动刷新健康检查" />
                </div>
                <div className="settings-fields-grid">
                  <div className="settings-field"><label htmlFor="health-normal-interval">服务正常时</label>
                    <Select id="health-normal-interval" className="settings-control" label="服务正常时的刷新间隔" value={healthRefresh.normalIntervalSeconds}
                      onChange={normalIntervalSeconds => updateHealthRefresh({ normalIntervalSeconds })}
                      options={HEALTH_NORMAL_INTERVALS.map(seconds => ({ value: seconds, label: seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟` }))} />
                  </div>
                  <div className="settings-field"><label htmlFor="health-retry-interval">未就绪或连接失败时</label>
                    <Select id="health-retry-interval" className="settings-control" label="未就绪或连接失败时的刷新间隔" value={healthRefresh.retryIntervalSeconds}
                      onChange={retryIntervalSeconds => updateHealthRefresh({ retryIntervalSeconds })}
                      options={HEALTH_RETRY_INTERVALS.map(seconds => ({ value: seconds, label: seconds < 60 ? `${seconds} 秒` : '1 分钟' }))} />
                  </div>
                </div>
                <p className="settings-health-refresh-help">默认正常时 15 秒、未就绪时 3 秒；从每次检查结束后计时。关闭自动刷新后仍可随时手动检查。</p>
                {healthRefreshError && <div className="settings-error" role="alert">{healthRefreshError}</div>}
              </div>
            </SettingsGroup>
            {config && <SettingsGroup title="内置后端 HTTPS" description="Java 只接受 HTTPS；这里只配置本机证书，不修改远程服务器或 Nginx 的 SSL 配置。" badge="本机">
              <div className="settings-field">
                <label htmlFor="builtin-tls-mode">证书模式</label>
                <Select id="builtin-tls-mode" className="settings-control" label="内置后端证书模式"
                  value={values.serverSslAutoGenerate === 'true' ? 'auto' : 'custom'}
                  onChange={mode => {
                    change('serverSslAutoGenerate', String(mode === 'auto'));
                    if (mode === 'auto') change('serverSslKeyStore', 'file:${app.config.data-directory}/tls/local-backend.p12');
                    if (mode === 'custom' && values.serverSslAutoGenerate === 'true') change('serverSslKeyStore', '');
                  }} options={[{ value: 'auto', label: 'HTTPS · 自动管理本机自签证书' },
                    { value: 'custom', label: 'HTTPS · 自定义证书库' }]} />
                <p className="settings-field-help">自动模式缺失时生成、有效时复用、临近过期续期。保存后需重启内置后端。</p>
              </div>
              {/*<BooleanConfigField settingKey="serverHttp2Enabled" label="启用 HTTP/2" values={values} config={config} change={change} />*/}
              {values.serverSslAutoGenerate !== 'true' && renderFields(tlsStoreFields)}
              {/*{values.serverSslAutoGenerate === 'true' && <PathPreviewCard*/}
              {/*  label="默认证书目录" icon="folder" path={childPath(values.dataDirectory, 'tls')}*/}
              {/*  hint="证书和随机密码仅保留在本机，不与远程连接共用。" />}*/}
            </SettingsGroup>}
            </div>
          </div>}

          {!loading && activeSection === 'model' && config && <div className="settings-columns settings-model-layout">
            <div className="settings-column" role="group" aria-label="模型服务与附件设置">
            <SettingsGroup title="模型渠道"
              description="配置后端调用的大模型服务。"
              badge="模型">
              <ProtocolCard />
              {renderFields(modelFields.filter(field => field.kind !== 'path-preset' && field.kind !== 'reasoning'))}
            </SettingsGroup>
            <SettingsGroup title="附件能力"
              description="控制 Agent 可以发送给模型的文件类型。"
              badge="附件">
              <MediaTypeEditor value={values.aiSupportedMediaTypes ?? ''} change={value => change('aiSupportedMediaTypes', value)} />
            </SettingsGroup>
            </div>
            <div className="settings-column" role="group" aria-label="模型接口与推理设置">
              <SettingsGroup title="接口与推理" description="调整对话、向量接口路径和推理强度。" badge="模型">
                {renderFields(modelFields.filter(field => field.kind === 'path-preset' || field.kind === 'reasoning'))}
              </SettingsGroup>
            </div>
          </div>}

          {!loading && activeSection === 'proxy' && config && <>
            <SettingsGroup title="AI 接口代理"
              description="仅影响模型对话与向量接口发出的 HTTP 请求。"
              expanded={values.aiProxyEnabled === 'true'}
              action={<Toggle label="启用 AI HTTP 代理" value={values.aiProxyEnabled === 'true'}
                onChange={value => change('aiProxyEnabled', String(value))} />}>
              {renderFields(aiProxyFields)}
            </SettingsGroup>
            <SettingsGroup title="SSH HTTP 代理"
              description="用于 SSH 连接需要经过 HTTP 代理服务器的场景。"
              expanded={values.sshProxyEnabled === 'true'}
              action={<Toggle label="启用 SSH HTTP 代理" value={values.sshProxyEnabled === 'true'}
                onChange={value => change('sshProxyEnabled', String(value))} />}>
              {renderFields(sshProxyFields)}
            </SettingsGroup>
          </>}

          {!loading && activeSection === 'storage' && config && <>
            <SettingsGroup title="文件存储"
              description="选择系统实际保存新文件的位置。切换选项时会自动启用对应存储。"
              badge="存储">
              <StorageModeSelector values={values} config={config} change={change} />
              <div key={activeStorageMode} className="settings-storage-config">
                <BooleanConfigField settingKey={activeStorageMode === 'local' ? 'localStorageEnabled' : 'minioEnabled'}
                  label={activeStorageMode === 'local' ? '启用本地存储' : '启用 MinIO'}
                  values={values} config={config} change={change} />
                {activeStorageMode === 'local' ? <>
                  <PathPreviewCard label="文件保存位置" icon="folder"
                    hint="跟随基础设置中的统一数据目录。"
                    path={config.values.localRootDirectory?.environmentOverride
                      ? values.localRootDirectory
                      : childPath(values.dataDirectory, 'files') || values.localRootDirectory || config.uploadDirectory} />
                  {renderFields(localStorageFields)}
                </> : <>
                  <p className="settings-field-help">请先创建存储桶，API 地址应填写服务地址。</p>
                  {renderFields(minioFields)}
                </>}
              </div>
            </SettingsGroup>
          </>}
        </section>
        {activeSection !== 'appearance' && activeSection !== 'about' && (showSaveBar || error || result) && <footer className="settings-footer" aria-label={`${activeDefinition.label}配置操作`}>
          {(error || result) && <div className="settings-footer-feedback">
            {error && <p className="settings-banner is-error" role="alert">
              <Icon name="alert" size={13} />{error}
            </p>}
            {result && <p className="settings-banner is-success" role="status">
              <Icon name="check" size={13} />{result}
            </p>}
          </div>}
          {showSaveBar && <TabSaveBar scope={activeDefinition.id}
            saveLabel={activeDefinition.saveLabel} hint={activeDefinition.saveHint}
            saving={saving} dirty={isTabDirty(activeSection)}
            onSave={() => void saveTab(activeSection)} onReset={() => resetTab(activeSection)} />}
        </footer>}
      </div>
    </div>
  </main>;
}
