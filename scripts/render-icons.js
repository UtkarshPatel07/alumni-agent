import zlib from 'node:zlib';
import fs from 'node:fs';

function makePng(width, height, pixelFn) {
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// Helper math
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return (u >= 0) && (v >= 0) && (u + v <= 1);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

// Distance to rounded squircle (box with corner radius)
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function renderPixel(x, y, w, h) {
  const scale = 512 / w;
  const sx = x * scale;
  const sy = y * scale;

  // 1. Squircle background check (center 256, 256)
  const dSquircle = sdRoundedBox(sx - 256, sy - 256, 226, 226, 96);
  if (dSquircle > 1.5) {
    return [0, 0, 0, 0]; // Transparent outer padding
  }

  // Base canvas gradient: rich midnight navy (#0e1428 to #050711)
  const tDiag = (sx + sy) / 1024;
  let r = Math.round(15 * (1 - tDiag) + 5 * tDiag);
  let g = Math.round(22 * (1 - tDiag) + 8 * tDiag);
  let b = Math.round(44 * (1 - tDiag) + 18 * tDiag);
  let a = 255;

  // Anti-alias squircle edge
  if (dSquircle > -1.5) {
    a = Math.round(255 * (1.5 - dSquircle) / 3);
  }

  // Ambient neon glow in center
  const distCenter = Math.hypot(sx - 256, sy - 240);
  if (distCenter < 190) {
    const glow = (1 - distCenter / 190) ** 1.8;
    // Blend with violet/cyan
    r = Math.min(255, r + Math.round(70 * glow));
    g = Math.min(255, g + Math.round(55 * glow));
    b = Math.min(255, b + Math.round(150 * glow));
  }

  // Glowing Rim along squircle edge
  if (dSquircle >= -6 && dSquircle <= 0) {
    const rimT = sx / 512;
    // Cyan to Purple
    const rr = Math.round(34 * (1 - rimT) + 168 * rimT);
    const gg = Math.round(211 * (1 - rimT) + 85 * rimT);
    const bb = Math.round(238 * (1 - rimT) + 247 * rimT);
    const blend = 0.65;
    r = Math.round(r * (1 - blend) + rr * blend);
    g = Math.round(g * (1 - blend) + gg * blend);
    b = Math.round(b * (1 - blend) + bb * blend);
  }

  // 2. Constellation Lines
  const lines = [
    [140, 360, 256, 400],
    [372, 360, 256, 400],
    [256, 400, 256, 335],
    [140, 360, 206, 320],
    [372, 360, 306, 320]
  ];
  for (const [x1, y1, x2, y2] of lines) {
    const dl = distToSegment(sx, sy, x1, y1, x2, y2);
    if (dl < 3.2) {
      const alpha = Math.max(0, 1 - dl / 3.2) * 0.75;
      r = Math.round(r * (1 - alpha) + 56 * alpha);
      g = Math.round(g * (1 - alpha) + 189 * alpha);
      b = Math.round(b * (1 - alpha) + 248 * alpha);
    }
  }

  // 3. Constellation Nodes (Orbs)
  const nodes = [
    [140, 360, 8, [34, 211, 238]],
    [372, 360, 8, [168, 85, 247]],
    [256, 400, 10, [56, 189, 248]]
  ];
  for (const [nx, ny, rad, col] of nodes) {
    const dn = Math.hypot(sx - nx, sy - ny);
    if (dn < rad * 2.2) {
      const glow = Math.max(0, 1 - dn / (rad * 2.2));
      const blend = dn <= rad ? 1 : glow * 0.6;
      r = Math.round(r * (1 - blend) + col[0] * blend);
      g = Math.round(g * (1 - blend) + col[1] * blend);
      b = Math.round(b * (1 - blend) + col[2] * blend);
    }
  }

  // 4. Stylized "A" Monogram Lines
  const aLines = [
    [222, 356, 256, 298],
    [256, 298, 290, 356],
    [234, 336, 278, 336]
  ];
  for (const [x1, y1, x2, y2] of aLines) {
    const da = distToSegment(sx, sy, x1, y1, x2, y2);
    if (da < 5.0) {
      const blend = Math.max(0, 1 - da / 5.0);
      r = Math.round(r * (1 - blend) + 103 * blend);
      g = Math.round(g * (1 - blend) + 232 * blend);
      b = Math.round(b * (1 - blend) + 249 * blend);
    }
  }

  // 5. Graduation Cap Base (Under-skull arc)
  // Check if inside ellipse arc
  const underDx = (sx - 256) / 80;
  const underDy = (sy - 264) / 44;
  if (underDx * underDx + underDy * underDy <= 1 && sy >= 235 && sy <= 290) {
    const skullGrad = (sy - 235) / 55;
    const sr = Math.round(79 * (1 - skullGrad) + 30 * skullGrad);
    const sg = Math.round(70 * (1 - skullGrad) + 27 * skullGrad);
    const sb = Math.round(229 * (1 - skullGrad) + 75 * skullGrad);
    r = sr; g = sg; b = sb;
  }

  // 6. Mortarboard Diamond (Top Cap)
  // Polygon: (256, 122), (426, 204), (256, 276), (86, 204)
  const inTri1 = pointInTriangle(sx, sy, 256, 122, 426, 204, 256, 276);
  const inTri2 = pointInTriangle(sx, sy, 256, 122, 256, 276, 86, 204);
  if (inTri1 || inTri2) {
    // Beautiful gradient: Sky Blue (#38bdf8) -> Indigo (#6366f1) -> Purple (#a855f7)
    const capT = (sx - 86) / 340;
    const cr = Math.round(56 * (1 - capT) + 168 * capT);
    const cg = Math.round(189 * (1 - capT) + 85 * capT);
    const cb = Math.round(248 * (1 - capT) + 247 * capT);
    r = cr; g = cg; b = cb;

    // Mortarboard edge highlight
    const dEdge = Math.min(
      distToSegment(sx, sy, 256, 122, 426, 204),
      distToSegment(sx, sy, 426, 204, 256, 276),
      distToSegment(sx, sy, 256, 276, 86, 204),
      distToSegment(sx, sy, 86, 204, 256, 122)
    );
    if (dEdge < 2.5) {
      const hilite = Math.max(0, 1 - dEdge / 2.5) * 0.8;
      r = Math.min(255, Math.round(r + 140 * hilite));
      g = Math.min(255, Math.round(g + 140 * hilite));
      b = Math.min(255, Math.round(b + 140 * hilite));
    }
  }

  // 7. Cap Center Gold Button
  const btnDist = Math.hypot((sx - 256) / 10, (sy - 198) / 6);
  if (btnDist <= 1.0) {
    r = 254; g = 240; b = 138;
  }

  // 8. Tassel Ribbon
  // Parametric curve from (256, 198) -> (382, 330)
  const dRibbon = distToSegment(sx, sy, 256, 198, 330, 220) + distToSegment(sx, sy, 330, 220, 382, 328);
  const dCurve = Math.min(
    distToSegment(sx, sy, 256, 198, 310, 212),
    distToSegment(sx, sy, 310, 212, 360, 248),
    distToSegment(sx, sy, 360, 248, 384, 328)
  );
  if (dCurve < 3.5) {
    const blend = Math.max(0, 1 - dCurve / 3.5);
    r = Math.round(r * (1 - blend) + 245 * blend);
    g = Math.round(g * (1 - blend) + 158 * blend);
    b = Math.round(b * (1 - blend) + 11 * blend);
  }

  // Tassel Tip Brush
  if (pointInTriangle(sx, sy, 384, 326, 372, 366, 396, 366)) {
    r = 245; g = 158; b = 11;
  }
  const dRing = Math.hypot(sx - 384, sy - 328);
  if (dRing < 5.0) {
    r = 255; g = 255; b = 255;
  }

  // 9. Core Center Light Pulse
  const dCore = Math.hypot(sx - 256, sy - 224);
  if (dCore < 6) {
    r = 255; g = 255; b = 255;
  } else if (dCore < 14) {
    const ringBlend = Math.max(0, 1 - Math.abs(dCore - 11) / 3) * 0.7;
    r = Math.round(r * (1 - ringBlend) + 34 * ringBlend);
    g = Math.round(g * (1 - ringBlend) + 211 * ringBlend);
    b = Math.round(b * (1 - ringBlend) + 238 * ringBlend);
  }

  return [r, g, b, a];
}

console.log('Rendering application icons...');
const icon512 = makePng(512, 512, renderPixel);
fs.writeFileSync('public/icon-512.png', icon512);
console.log('✓ public/icon-512.png (512x512, ' + icon512.length + ' bytes)');

const icon192 = makePng(192, 192, renderPixel);
fs.writeFileSync('public/icon-192.png', icon192);
console.log('✓ public/icon-192.png (192x192, ' + icon192.length + ' bytes)');

const iconApple = makePng(180, 180, renderPixel);
fs.writeFileSync('public/apple-touch-icon.png', iconApple);
console.log('✓ public/apple-touch-icon.png (180x180, ' + iconApple.length + ' bytes)');

const favicon32 = makePng(32, 32, renderPixel);
fs.writeFileSync('public/favicon-32x32.png', favicon32);
console.log('✓ public/favicon-32x32.png (32x32, ' + favicon32.length + ' bytes)');

// Also write favicon.ico from 32x32 PNG
function makeIco(pngBuffer) {
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0); // reserved
  icoHeader.writeUInt16LE(1, 2); // ICO format
  icoHeader.writeUInt16LE(1, 4); // 1 image

  const icoEntry = Buffer.alloc(16);
  icoEntry.writeUInt8(32, 0); // width
  icoEntry.writeUInt8(32, 1); // height
  icoEntry.writeUInt8(0, 2);  // color palette
  icoEntry.writeUInt8(0, 3);  // reserved
  icoEntry.writeUInt16LE(1, 4); // color planes
  icoEntry.writeUInt16LE(32, 6); // bits per pixel
  icoEntry.writeUInt32LE(pngBuffer.length, 8); // image size
  icoEntry.writeUInt32LE(22, 12); // offset (6 + 16)

  return Buffer.concat([icoHeader, icoEntry, pngBuffer]);
}

const faviconIco = makeIco(favicon32);
fs.writeFileSync('public/favicon.ico', faviconIco);
console.log('✓ public/favicon.ico (' + faviconIco.length + ' bytes)');
