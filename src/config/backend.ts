const STORAGE_KEY = 'agent-ssh-backend-url-v1';
const DEVELOPMENT_BACKEND = 'http://localhost:8888';

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
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeBackendUrl(saved);
  } catch {
    // 首次启动或 WebView 存储不可用时回退到未配置状态。
  }
  // 开发环境保留本机默认值；正式安装包首次启动必须由用户配置。
  return import.meta.env.DEV ? DEVELOPMENT_BACKEND : '';
}

export function saveBackendUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    throw new Error('无法保存本机设置，请检查客户端存储权限。');
  }
  return normalized;
}

export function requireBackendUrl(): string {
  const url = readBackendUrl();
  if (!url) throw new Error('请先在客户端设置中配置后端服务器地址。');
  return url;
}
