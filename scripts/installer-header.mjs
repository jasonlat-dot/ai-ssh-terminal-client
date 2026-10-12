import { inflateSync } from 'node:zlib';

// Tauri's SVG renderer outputs non-interlaced, 8-bit PNGs. Decode only that
// format so icon preparation stays portable and needs no image dependencies.
export function decodeIconPng(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(signature)) throw new Error('Invalid icon PNG.');
  let width, height, channels;
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (offset + length + 12 > png.length) throw new Error('Truncated icon PNG.');
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!width || !height || width > 1024 || height > 1024
        || data[8] !== 8 || !channels || data[10] || data[11] || data[12]) {
        throw new Error('Unsupported icon PNG format.');
      }
    } else if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (!channels || !compressed.length) throw new Error('Incomplete icon PNG.');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid icon pixel data.');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Unsupported PNG filter.');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const above = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) {
        const p = left + above - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      }
      pixels[y * stride + x] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  return { width, height, channels, pixels };
}

export function createInstallerHeader(iconPng) {
  const icon = decodeIconPng(iconPng);
  const width = 150, height = 57;
  if (icon.width !== 52 || icon.height !== 52) throw new Error('Installer header needs a 52px icon.');
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bitmap = Buffer.alloc(54 + stride * height, 255);
  bitmap.fill(0, 0, 54);
  bitmap.write('BM');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(stride * height, 34);
  // NSIS headers are white. Flatten transparency and keep the square icon at
  // the right edge without stretching it to the header's wide aspect ratio.
  const left = width - icon.width - 4, top = 2;
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      const source = (y * icon.width + x) * icon.channels;
      const target = 54 + (height - 1 - top - y) * stride + (left + x) * 3;
      const alpha = icon.channels === 4 ? icon.pixels[source + 3] / 255 : 1;
      for (let c = 0; c < 3; c++) {
        bitmap[target + c] = Math.round(icon.pixels[source + 2 - c] * alpha + 255 * (1 - alpha));
      }
    }
  }
  return bitmap;
}
