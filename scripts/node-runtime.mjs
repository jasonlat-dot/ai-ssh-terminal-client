import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const requirement = 'Node 20.19+ 或 Node 22.12+（包括 Node 24）';

// Keep this bootstrap readable by Node 18: do not import Vite before selecting a runtime.
export function supportedVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

export function findRuntime({
  env = process.env, current = process.execPath, home = homedir(),
  exists = existsSync,
  version = executable => spawnSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).stdout || '',
} = {}) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = env.SHELLPILOT_NODE ? [env.SHELLPILOT_NODE] : [
    current,
    env.npm_node_execpath,
    ...(env[pathKey] || '').split(delimiter).filter(Boolean).map(dir => join(dir, executable)),
    // Optional existing Codex runtime; no download and no user-specific absolute path.
    join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', executable),
  ];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (!exists(candidate)) continue;
    if (supportedVersion(version(candidate))) return candidate;
  }
  throw new Error(
    '开发工具需要 ' + requirement + '。当前 Node ' + process.version + ' 不可用，未找到兼容版本。' +
    '请安装兼容 Node，或将 SHELLPILOT_NODE 设为已有 node.exe 的完整路径。',
  );
}

export function runtimeEnvironment(executable, env = process.env) {
  const result = {...env};
  const pathKey = Object.keys(result).find(key => key.toLowerCase() === 'path') || 'PATH';
  result[pathKey] = [dirname(executable), result[pathKey] || ''].filter(Boolean).join(delimiter);
  result.npm_node_execpath = executable;
  return result;
}

export function runTool(tool, args = []) {
  const packages = {vite: 'vite', tauri: '@tauri-apps/cli', tsc: 'typescript'};
  if (!Object.hasOwn(packages, tool)) throw new Error('未知开发工具：' + (tool || '(empty)'));
  const executable = findRuntime();
  const manifestPath = require.resolve(packages[tool] + '/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[tool];
  if (!bin) throw new Error('找不到 ' + tool + ' 的开发入口');
  if (resolve(executable) !== resolve(process.execPath)) {
    console.log('[ShellPilot] 使用兼容 Node：' + executable);
  }
  const result = spawnSync(executable, [resolve(dirname(manifestPath), bin), ...args], {
    stdio: 'inherit', env: runtimeEnvironment(executable),
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTool(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error('[ShellPilot] ' + error.message);
    process.exitCode = 1;
  }
}
