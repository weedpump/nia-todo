/** Read bounded raster headers without allocating a decoded bitmap. */
export function rasterImageDimensions(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const invalid = () => { throw new Error('Invalid raster image header'); };
  const requireBytes = (offset, size) => { if (offset < 0 || offset + size > bytes.length) invalid(); };
  const u16 = (offset, little = false) => { requireBytes(offset, 2); return view.getUint16(offset, little); };
  const u32 = (offset, little = false) => { requireBytes(offset, 4); return view.getUint32(offset, little); };
  const text = offset => String.fromCharCode(...bytes.slice(offset, offset + 4));
  const dimensions = [];
  if (bytes.length >= 24 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
    if (text(12) !== 'IHDR' || u32(8) !== 13) invalid();
    dimensions.push({ width: u32(16), height: u32(20) });
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      const length = u16(offset); if (length < 2) invalid(); requireBytes(offset, length);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) invalid(); dimensions.push({ width: u16(offset + 5), height: u16(offset + 3) }); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && text(0) === 'RIFF' && text(8) === 'WEBP') {
    const end = u32(4, true) + 8; if (end > bytes.length) invalid();
    for (let offset = 12; offset + 8 <= end;) {
      const kind = text(offset), size = u32(offset + 4, true), data = offset + 8;
      requireBytes(data, size); if (data + size > end) invalid();
      if (kind === 'ANIM' || kind === 'ANMF') invalid();
      if (kind === 'VP8X') {
        if (size < 10 || bytes[data] & 2) invalid();
        dimensions.push({ width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16),
          height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16) });
      } else if (kind === 'VP8L') {
        if (size < 5 || bytes[data] !== 0x2f) invalid();
        const bits = u32(data + 1, true); dimensions.push({ width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) });
      } else if (kind === 'VP8 ') {
        if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 1 || bytes[data + 5] !== 0x2a) invalid();
        dimensions.push({ width: u16(data + 6, true) & 0x3fff, height: u16(data + 8, true) & 0x3fff });
      }
      offset = data + size + (size & 1);
    }
  }
  if (!dimensions.length || dimensions.some(({ width, height }) => width <= 0 || height <= 0)) invalid();
  return dimensions;
}
