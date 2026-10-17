import type { McpServer } from '../api/agentExtensions';

export const savedMcpValue = '__SHELLPILOT_SAVED__';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (path: string, message: string): never => { throw new Error(`${path}：${message}`); };
function stringMap(value: unknown, path: string): Record<string, string> {
  if (!object(value) || Object.entries(value).some(([key, item]) => !key || typeof item !== 'string')) return fail(path, '须为名称与字符串值组成的对象。');
  return value as Record<string, string>;
}
function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return fail(path, '须为字符串数组。');
  return value;
}
// JSON.parse validates syntax first; this scan catches duplicate keys before they are silently overwritten.
function rejectDuplicates(raw: string) {
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  let index = 0;
  function value(depth: number) {
    if (depth > 32) fail('MCP JSON', '嵌套层级过多。');
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]) as string;
        if (keys.has(key)) fail('MCP JSON', '存在重复字段或重复服务名，请删除重复项。');
        keys.add(key); index++; value(depth + 1);
        if (tokens[index] === ',') index++; else break;
      }
      index++;
    } else if (token === '[') {
      while (tokens[index] !== ']') { value(depth + 1); if (tokens[index] === ',') index++; else break; }
      index++;
    }
  }
  value(0);
}

export function parseMcpConfig(raw: string): McpServer[] {
  if (raw.length > 262144) return fail('MCP JSON', '配置不能超过 256 KiB。');
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return fail('MCP JSON', '格式错误，请检查双引号、逗号和括号；多个服务请放在同一个 mcpServers 对象内。'); }
  rejectDuplicates(raw);
  if (!object(root) || !object(root.mcpServers) || Object.keys(root).some(key => key !== 'mcpServers')) return fail('MCP JSON', '顶层须为 { "mcpServers": { ... } }。');
  if (Object.keys(root.mcpServers).length > 8) return fail('mcpServers', '最多配置 8 个服务。');
  return Object.entries(root.mcpServers).map(([name, spec]) => {
    const path = `mcpServers.${name}`;
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) return fail('mcpServers', '服务名须为 1–24 个英文字母、数字、下划线或连字符。');
    if (!object(spec)) return fail(path, '服务配置须为对象。');
    const allowed = ['type', 'transport', 'description', 'enabled', 'disabled', 'url', 'baseUrl', 'headers', 'bearerEnv', 'command', 'args', 'env', 'inheritEnv', 'timeoutSeconds'];
    if (Object.keys(spec).some(key => !allowed.includes(key))) return fail(path, `支持的字段为 ${allowed.join('、')}。`);
    if (spec.type !== undefined && spec.transport !== undefined && spec.type !== spec.transport) return fail(path, 'type 与 transport 不能冲突。');
    if (spec.url !== undefined && spec.baseUrl !== undefined && spec.url !== spec.baseUrl) return fail(path, 'url 与 baseUrl 不能冲突。');
    if (spec.enabled !== undefined && typeof spec.enabled !== 'boolean' || spec.disabled !== undefined && typeof spec.disabled !== 'boolean') return fail(path, 'enabled / disabled 须为布尔值。');
    if (spec.enabled !== undefined && spec.disabled !== undefined && spec.enabled === spec.disabled) return fail(path, 'enabled 与 disabled 不能冲突。');
    if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > 2048)) return fail(path, 'description 须为不超过 2048 字符的字符串。');
    const common = { name, enabled: spec.enabled as boolean | undefined ?? spec.disabled !== true, ...(spec.description === undefined ? {} : { description: spec.description as string }) };
    const url = spec.url ?? spec.baseUrl;
    const explicit = spec.type ?? spec.transport;
    let type: unknown = explicit;
    if (type === undefined) {
      if (spec.command !== undefined) type = 'stdio';
      else if (typeof url === 'string') {
        try { type = /(?:^|\/)sse\/?$/i.test(new URL(url).pathname) ? 'sse' : 'streamableHttp'; } catch { return fail(path, 'url / baseUrl 须为完整 HTTP 或 HTTPS 地址。'); }
      }
    }
    if (type === 'http' || type === 'streamable-http') type = 'streamableHttp';
    if (type === 'stdio') {
      if (url !== undefined || spec.headers !== undefined || spec.bearerEnv !== undefined || spec.timeoutSeconds !== undefined) return fail(path, 'stdio 使用 command、args、env，请移除 HTTP 专用字段。');
      if (typeof spec.command !== 'string' || !spec.command.trim() || spec.command.length > 2048 || /[\0\r\n]/.test(spec.command)) return fail(path, 'command 须为有效程序名称或绝对路径。');
      const args = spec.args === undefined ? [] : strings(spec.args, `${path}.args`);
      if (args.length > 64 || args.some(item => item.length > 8192 || item.includes('\0'))) return fail(path, 'args 最多 64 项，每项最多 8192 字符。');
      if (spec.inheritEnv !== undefined && Array.isArray(spec.env)) return fail(path, 'env 数组与 inheritEnv 请选择一种。');
      const inherited = spec.inheritEnv !== undefined ? strings(spec.inheritEnv, `${path}.inheritEnv`) : Array.isArray(spec.env) ? strings(spec.env, `${path}.env`) : [];
      const env = spec.env === undefined || Array.isArray(spec.env) ? {} : stringMap(spec.env, `${path}.env`);
      if (Object.keys(env).length + inherited.length > 32 || [...Object.keys(env), ...inherited].some(key => !/^[A-Za-z0-9_]{1,128}$/.test(key)) || Object.values(env).some(item => item.length > 8192 || item.includes('\0'))) return fail(path, 'env 最多 32 项，变量名只能含英文、数字和下划线，值不能含空字符。');
      return { ...common, transport: 'stdio', command: spec.command, args, env: inherited, connectionValues: { headers: {}, env } };
    }
    if (type !== 'streamableHttp' && type !== 'sse') return fail(path, 'type 支持 streamableHttp、sse、stdio。');
    if (spec.command !== undefined || spec.args !== undefined || spec.env !== undefined || spec.inheritEnv !== undefined) return fail(path, 'HTTP / SSE 请移除 command、args、env、inheritEnv。');
    if (typeof url !== 'string' || url.length > 4096) return fail(path, 'url / baseUrl 须为不超过 4096 字符的完整地址。');
    let address: URL;
    try { address = new URL(url); } catch { return fail(path, '地址缺少协议或格式不正确，请填写完整 https:// 地址。'); }
    const local = address.hostname === 'localhost' || address.hostname === '[::1]' || /^127\./.test(address.hostname);
    if (!(address.protocol === 'https:' || address.protocol === 'http:' && (type === 'sse' || local)) || !address.hostname || address.username || address.password || url.includes('#')) return fail(path, '远端 HTTP 服务须用 HTTPS，旧版 SSE / 本机回环可用 HTTP；地址不能含用户名、密码或 # 片段。');
    const headers = spec.headers === undefined ? {} : stringMap(spec.headers, `${path}.headers`);
    const lowered = new Set<string>();
    if (Object.keys(headers).length > 32) return fail(path, 'headers 最多 32 项。');
    for (const [key, item] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (key.length > 128 || lowered.has(lower) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(?:host|content-length|content-type|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version)$/.test(lower) || item.length > 8192 || /[^\x20-\x7e\t]/.test(item)) return fail(`${path}.headers`, '头名称须合法且不重复，值不能含换行；Host、传输和 MCP 会话头由客户端管理。');
      lowered.add(lower);
    }
    if (spec.bearerEnv !== undefined && (typeof spec.bearerEnv !== 'string' || spec.bearerEnv !== '' && !/^[A-Za-z0-9_]{1,128}$/.test(spec.bearerEnv))) return fail(path, 'bearerEnv 须为合法的旧环境变量名，可直接使用 headers.Authorization 替代。');
    const bearerEnv = spec.bearerEnv as string | undefined ?? '';
    if (bearerEnv && lowered.has('authorization')) return fail(path, 'headers.Authorization 与 bearerEnv 请选择一种。');
    const values = { headers, env: {} };
    if (type === 'sse') {
      const timeoutSeconds = spec.timeoutSeconds ?? 300;
      if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) return fail(path, 'timeoutSeconds 须为 1–300 之间的整数（秒）。');
      return { ...common, transport: 'sse', url, bearerEnv, timeoutSeconds, connectionValues: values };
    }
    if (spec.timeoutSeconds !== undefined) return fail(path, 'timeoutSeconds 当前仅用于旧版 SSE。');
    return { ...common, transport: 'streamableHttp', url, bearerEnv, connectionValues: values };
  });
}

export function formatMcpConfig(servers: McpServer[]): string {
  const entries = servers.map(server => {
    const spec: ObjectValue = { type: server.transport, enabled: server.enabled };
    if (server.description) spec.description = server.description;
    if (server.transport === 'stdio') {
      spec.command = server.command; spec.args = server.args;
      spec.env = Object.fromEntries((server.savedEnv ?? []).map(key => [key, savedMcpValue]));
      if (server.env.length) spec.inheritEnv = server.env;
    } else {
      spec.url = server.url;
      const headers = Object.fromEntries((server.savedHeaders ?? []).map(key => [key, savedMcpValue]));
      if (server.bearerTokenConfigured && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) headers.Authorization = savedMcpValue;
      if (Object.keys(headers).length) spec.headers = headers;
      if (server.bearerEnv) spec.bearerEnv = server.bearerEnv;
      if (server.transport === 'sse') spec.timeoutSeconds = server.timeoutSeconds;
    }
    return [server.name, spec];
  });
  return JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2);
}

export function validateSavedMcpValues(servers: McpServer[], previous: McpServer[]): void {
  for (const server of servers) {
    const old = previous.find(item => item.name === server.name);
    const sameTarget = old?.transport === server.transport && (server.transport === 'stdio' && old.transport === 'stdio'
      ? old.command === server.command && JSON.stringify(old.args) === JSON.stringify(server.args) && JSON.stringify(old.env) === JSON.stringify(server.env)
      : server.transport !== 'stdio' && old.transport !== 'stdio' && old.url === server.url);
    for (const [key, value] of Object.entries(server.connectionValues?.headers ?? {})) {
      const exists = old?.savedHeaders?.some(name => name.toLowerCase() === key.toLowerCase()) || key.toLowerCase() === 'authorization' && old?.bearerTokenConfigured;
      if (value === savedMcpValue && (!sameTarget || !exists)) fail(`mcpServers.${server.name}.headers`, '已保存的值无法用于这个服务或地址，请重新填写凭据。');
    }
    for (const [key, value] of Object.entries(server.connectionValues?.env ?? {})) {
      if (value === savedMcpValue && (!sameTarget || !old?.savedEnv?.includes(key))) fail(`mcpServers.${server.name}.env`, '已保存的值无法用于这个命令或启动参数，请重新填写环境变量值。');
    }
  }
}

export const mcpExamples = {
  streamableHttp: { type: 'streamableHttp', description: '搜索实时信息', baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/mcp', headers: { Authorization: 'Bearer YOUR_API_KEY' }, enabled: false },
  sse: { type: 'sse', url: 'http://appbuilder.baidu.com/v2/ai_search/mcp/sse?api_key=YOUR_API_KEY', enabled: false },
  stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/workspace'], env: {}, enabled: false },
} as const;
