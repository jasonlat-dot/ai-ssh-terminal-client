import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renameBundleArtifacts, validateDisplayName } from './bundle-names.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundles = process.argv[2];
try {
  if (!['nsis', 'msi', 'nsis,msi'].includes(bundles) || process.argv.length !== 3) {
    throw new Error('用法：node scripts/windows-bundle.mjs nsis|msi|nsis,msi');
  }
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const displayName = validateDisplayName(packageInfo.displayName);
  const result = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', bundles], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri 打包失败，退出码 ${result.status}`);
  for (const kind of bundles.split(',')) {
    const renamed = renameBundleArtifacts(join(root, 'src-tauri/target/release/bundle', kind), {
      productName: config.productName, displayName, version: config.version,
    });
    for (const name of renamed) console.log(`安装包：${name}`);
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
