import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceIcon = join(projectRoot, 'public', 'icon.svg');
const nativeIconDirectory = join(projectRoot, 'src-tauri', 'icons');
const desktopIcons = [
  '32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns',
  'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
  'Square89x89Logo.png', 'Square107x107Logo.png', 'Square142x142Logo.png',
  'Square150x150Logo.png', 'Square284x284Logo.png', 'Square310x310Logo.png', 'StoreLogo.png',
];

const temporaryBase = resolve(tmpdir());
const temporaryIcons = mkdtempSync(join(temporaryBase, 'agent-ssh-icons-'));
const temporaryRelative = relative(temporaryBase, temporaryIcons);
if (!temporaryRelative || temporaryRelative.startsWith('..') || isAbsolute(temporaryRelative)
  || !basename(temporaryIcons).startsWith('agent-ssh-icons-')) {
  throw new Error('Unexpected temporary icon directory.');
}

try {
  execFileSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'icon', sourceIcon, '--output', temporaryIcons], {
    cwd: projectRoot,
    stdio: 'pipe',
    windowsHide: true,
  });
  mkdirSync(nativeIconDirectory, { recursive: true });
  let updated = 0;
  for (const name of desktopIcons) {
    const bytes = readFileSync(join(temporaryIcons, name));
    const destination = join(nativeIconDirectory, name);
    // Preserve timestamps so unchanged icons do not trigger a native recompilation.
    if (existsSync(destination) && readFileSync(destination).equals(bytes)) continue;
    writeFileSync(destination, bytes);
    updated += 1;
  }
  console.info(`Application icons synchronized from public/icon.svg (${updated} updated).`);
} finally {
  // This is the checked, uniquely created directory above, containing only generated assets.
  rmSync(temporaryIcons, { recursive: true, force: true });
}
