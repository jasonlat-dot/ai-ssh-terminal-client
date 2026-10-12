import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { createInstallerHeader, decodeIconPng } from '../scripts/installer-header.mjs';

const file = path => readFileSync(new URL(`../${path}`, import.meta.url));
function pngFixture(filter, rgba = [60, 120, 180, 128], channels = 4) {
  const size = 52, stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = filter;
    for (let x = 0; x < stride; x++) {
      const pixel = rgba[x % channels];
      const left = x >= channels ? pixel : 0;
      const above = y ? pixel : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = x >= channels ? left : above;
      raw[row + 1 + x] = pixel - predictor;
    }
  }
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    // The small decoder consumes only trusted renderer output, not PNG CRCs.
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('installer header decodes all renderer PNG filters and flattens alpha on white', () => {
  for (let filter = 0; filter <= 4; filter++) {
    const png = pngFixture(filter);
    const decoded = decodeIconPng(png);
    for (let p = 0; p < decoded.pixels.length; p += 4) {
      assert.deepEqual([...decoded.pixels.subarray(p, p + 4)], [60, 120, 180, 128]);
    }
    const bmp = createInstallerHeader(png);
    assert.equal(bmp.toString('ascii', 0, 2), 'BM');
    assert.equal(bmp.readUInt32LE(2), bmp.length);
    assert.equal(bmp.readUInt32LE(10), 54);
    assert.equal(bmp.readInt32LE(18), 150);
    assert.equal(bmp.readInt32LE(22), 57);
    assert.equal(bmp.readUInt16LE(28), 24);
    const pixel = (x, y) => [...bmp.subarray(54 + (56 - y) * 452 + x * 3, 57 + (56 - y) * 452 + x * 3)];
    assert.deepEqual(pixel(94, 2), [217, 187, 157]); // bottom-up BGR, square, un-stretched
    assert.deepEqual(pixel(145, 53), [217, 187, 157]);
    assert.deepEqual(pixel(93, 2), [255, 255, 255]);
    assert.deepEqual(pixel(146, 53), [255, 255, 255]);
    assert.deepEqual(pixel(94, 54), [255, 255, 255]);
    assert.deepEqual(pixel(0, 0), [255, 255, 255]);
  }
  assert.equal(decodeIconPng(pngFixture(4, [60, 120, 180], 3)).channels, 3);
  assert.doesNotThrow(() => createInstallerHeader(pngFixture(4, [60, 120, 180], 3)));
  assert.throws(() => decodeIconPng(Buffer.from('not png')), /Invalid icon PNG/);
  assert.throws(() => decodeIconPng(pngFixture(5)), /PNG filter/);
  assert.throws(() => decodeIconPng(pngFixture(0).subarray(0, 32)), /Truncated/);
});

test('window/taskbar, installer and uninstaller share the SVG-derived application icon', () => {
  const config = JSON.parse(file('src-tauri/tauri.conf.json'));
  assert.ok(config.bundle.icon.includes('icons/icon.ico'));
  const nsis = config.bundle.windows.nsis;
  assert.match(file(`src-tauri/${nsis.installerHooks}`).toString(), /!define MUI_HEADERIMAGE_RIGHT/);
  assert.equal(nsis.installerIcon, 'icons/icon.ico');
  assert.equal(nsis.uninstallerIcon, nsis.installerIcon);
  assert.equal(nsis.headerImage, 'icons/installer-header.bmp');
  assert.equal(nsis.uninstallerHeaderImage, nsis.headerImage);
  const ico = file(`src-tauri/${nsis.installerIcon}`);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    sizes.push(ico[6 + i * 16] || 256);
    const offset = ico.readUInt32LE(6 + i * 16 + 12);
    const length = ico.readUInt32LE(6 + i * 16 + 8);
    assert.ok(offset + length <= ico.length);
  }
  assert.ok(sizes.includes(32), 'small taskbar/window icon');
  assert.ok(sizes.includes(256), 'high-resolution shortcut/explorer icon');
  const bmp = file(`src-tauri/${nsis.headerImage}`);
  assert.equal(bmp.toString('ascii', 0, 2), 'BM');
  assert.equal(bmp.readInt32LE(18), 150);
  assert.equal(bmp.readInt32LE(22), 57);
  const script = file('scripts/prepare-app-icons.mjs').toString();
  assert.match(script, /'public', 'icon\.svg'/);
  assert.match(script, /createInstallerHeader/);
  const scripts = JSON.parse(file('package.json')).scripts;
  assert.match(scripts.predev, /prepare:icons/);
  assert.match(scripts.prebuild, /prepare:icons/);
  assert.match(scripts['prepare:bundle'], /npm run build/);
  assert.match(file('src-tauri/src/lib.rs').toString(), /tauri::generate_context!\(\)/);
});
