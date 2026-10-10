const STORAGE_KEY = 'agent-ssh-backend-url-v1';
const DEVELOPMENT_BACKEND = 'https://localhost:8888';
const CONNECTIONS_KEY = 'agent-ssh-backend-connections-v2';
export const BUILTIN_BACKEND_ID = 'builtin';

/** 客户端连接档案：只保存地址及公开证书，绝不保存远程服务器私钥。 */
export type BackendConnectionProfile = {
  id: string;
  name: string;
  kind: 'builtin' | 'remote';
  url: string;
  trust: 'system' | 'certificate';
  certificatePem: string;
};
type BackendConnections = { version: 2; activeId: string; profiles: BackendConnectionProfile[] };

/** 默认档案与旧版单地址兼容；读失败不覆盖磁盘中的原始配置。 */
export function readBackendConnections(): BackendConnections {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (raw) {
      const data = JSON.parse(raw) as BackendConnections;
      if (data.version === 2 && Array.isArray(data.profiles)) {
        const profiles = data.profiles.map(profile => validateBackendProfile(profile));
        if (profiles.filter(profile => profile.id === BUILTIN_BACKEND_ID).length === 1
            && new Set(profiles.map(profile => profile.id)).size === profiles.length
            && profiles.some(profile => profile.id === data.activeId)) return { ...data, profiles };
      }
    }
  } catch { /* 存储不可用或旧文件损坏时仍允许进入设置页修正。 */ }
  let previous = DEVELOPMENT_BACKEND;
  try { previous = normalizeBackendUrl(localStorage.getItem(STORAGE_KEY) || previous); } catch { /* 默认本机地址。 */ }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(previous).hostname);
  const builtin: BackendConnectionProfile = {
    id: BUILTIN_BACKEND_ID, name: '内置后端', kind: 'builtin',
    url: local ? previous : DEVELOPMENT_BACKEND, trust: 'system', certificatePem: '',
  };
  const profiles = [builtin];
  if (!local) profiles.push({ id: 'legacy-remote', name: '远程后端', kind: 'remote', url: previous, trust: 'system', certificatePem: '' });
  return { version: 2, activeId: local ? BUILTIN_BACKEND_ID : 'legacy-remote', profiles };
}

/** 检查档案边界，防止 HTTP 配置携带证书、远程档案伪装成本机自动信任。 */
function validateBackendProfile(profile: BackendConnectionProfile): BackendConnectionProfile {
  if (!profile || !profile.id || !profile.name?.trim()) throw new Error('请输入连接名称。');
  const url = normalizeBackendUrl(profile.url);
  const builtin = profile.id === BUILTIN_BACKEND_ID;
  if (profile.kind !== (builtin ? 'builtin' : 'remote')) throw new Error('连接类型不合法。');
  if (builtin && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('内置后端只能使用本机回环地址。');
  }
  if (!builtin && !['system', 'certificate'].includes(profile.trust)) throw new Error('请选择证书验证方式。');
  const certificatePem = !builtin && profile.trust === 'certificate' ? profile.certificatePem.trim() : '';
  if (!builtin && profile.trust === 'certificate') {
    if (!url.startsWith('https://')) throw new Error('指定证书仅适用于 HTTPS 连接。');
    if (certificatePem.length > 16_384 || !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(certificatePem)) {
      throw new Error('请导入单张 PEM 格式的服务器公开证书，不能导入私钥或证书链。');
    }
  }
  return { id: profile.id, name: builtin ? '内置后端' : profile.name.trim(), kind: profile.kind, url,
    trust: builtin ? 'system' : profile.trust, certificatePem };
}

/** 单独保存档案，不修改活动连接，也不写内置后端 YAML。 */
export function saveBackendConnection(profile: BackendConnectionProfile): BackendConnectionProfile {
  const next = validateBackendProfile(profile);
  const data = readBackendConnections();
  const index = data.profiles.findIndex(item => item.id === next.id);
  if (index < 0) data.profiles.push(next); else data.profiles[index] = next;
  persistConnections(data);
  return next;
}

function persistConnections(data: BackendConnections): void {
  try { localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(data)); }
  catch { throw new Error('无法保存本机连接设置，请检查客户端存储权限。'); }
}

export function activeBackendConnection(): BackendConnectionProfile {
  const data = readBackendConnections();
  return data.profiles.find(profile => profile.id === data.activeId)!;
}

/** 切换仅变更活动 ID；保留所有本地/远程档案和各自的证书设置。 */
export function activateBackendConnection(id: string): string {
  const data = readBackendConnections();
  const selected = data.profiles.find(profile => profile.id === id);
  if (!selected) throw new Error('连接配置不存在，请重新选择。');
  persistConnections({ ...data, activeId: id });
  return selected.url;
}

/** 不允许删除正在使用的连接，避免后台请求仍访问已删除的证书档案。 */
export function deleteBackendConnection(id: string): void {
  const data = readBackendConnections();
  if (id === BUILTIN_BACKEND_ID || id === data.activeId) throw new Error('不能删除内置后端或正在使用的连接。');
  persistConnections({ ...data, profiles: data.profiles.filter(profile => profile.id !== id) });
}

/**
 * 这里只保存服务器根地址。/agent 和 /api/v1/ssh 由各自 API 模块追加，
 * 不能把 Vite 的 VITE_* 环境变量当成安装后可修改的客户端配置。
 */
export function normalizeBackendUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('请输入后端服务器地址。');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('地址格式无效，例如 https://api.example.com 或 http://192.168.1.10:8888。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('后端地址只能使用 http:// 或 https://。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('后端地址不能包含用户名、密码、查询参数或锚点。');
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/agent') || path.endsWith('/api/v1/ssh')) {
    throw new Error('请填写服务器根地址，不要附加 /agent 或 /api/v1/ssh。');
  }
  return url.origin + path;
}

export function readBackendUrl(): string {
  return activeBackendConnection().url;
}

export function saveBackendUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  const active = activeBackendConnection();
  // 兼容启动页旧的“填写地址”入口：本机档案不能被远程地址覆盖。
  if (active.kind === 'builtin' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(normalized).hostname)) {
    const profile = saveBackendConnection({ id: crypto.randomUUID(), name: '远程后端', kind: 'remote',
      url: normalized, trust: 'system', certificatePem: '' });
    activateBackendConnection(profile.id);
  } else if (active.url !== normalized) saveBackendConnection({ ...active, url: normalized });
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    throw new Error('无法保存本机设置，请检查客户端存储权限。');
  }
  return normalized;
}

/**
 * 内置后端启动后同步真实协议/端口，迁移旧版默认 HTTP 地址。
 * 明确配置的远程服务、带路径的代理地址或其他本地端口保持不变。
 */
export function adoptBundledBackendUrl(actual: string | null | undefined): string {
  const current = readBackendUrl();
  if (!actual) return current;
  const normalized = normalizeBackendUrl(actual);
  const data = readBackendConnections();
  const builtin = data.profiles.find(profile => profile.id === BUILTIN_BACKEND_ID)!;
  if (builtin.url !== normalized) saveBackendConnection({ ...builtin, url: normalized });
  // 内置服务在后台启动不代表用户要从远程切回本地，只有显式选择才能改变活动连接。
  return data.activeId === BUILTIN_BACKEND_ID ? normalized : current;
}

export function requireBackendUrl(): string {
  const url = readBackendUrl();
  if (!url) throw new Error('请先在客户端设置中配置后端服务器地址。');
  return url;
}
