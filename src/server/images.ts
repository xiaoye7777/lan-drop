// 根据文件开头的字节识别图片格式和尺寸。
// 不看文件名和浏览器声明的类型，因为这两样都可以随便改。
import type { ImageType } from '../shared/types.js';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

/** 识别 JPEG 尺寸需要往后找，读这么多字节足够跳过大部分照片自带的 EXIF 信息 */
export const IMAGE_HEAD_BYTES = 512 * 1024;

/**
 * 像素数上限。几 MB 的图片也可能声明几万乘几万的尺寸，
 * 浏览器解码时会吃掉大量内存，这种图片不允许预览、不能当表情或头像。
 */
const MAX_PIXELS = 50_000_000;
const MAX_SIDE = 20_000;

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  return buf.length >= offset + bytes.length && bytes.every((byte, i) => buf[offset + i] === byte);
}

function ascii(buf: Buffer, offset: number, length: number): string {
  return buf.toString('latin1', offset, offset + length);
}

function pngSize(buf: Buffer): [number, number] | null {
  if (buf.length < 24 || ascii(buf, 12, 4) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function gifSize(buf: Buffer): [number, number] | null {
  if (buf.length < 10) return null;
  return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
}

function webpSize(buf: Buffer): [number, number] | null {
  if (buf.length < 30) return null;
  switch (ascii(buf, 12, 4)) {
    case 'VP8 ': // 有损压缩
      if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
      return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    case 'VP8L': {
      // 无损压缩：宽高各占 14 位，存的是减 1 后的值
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    case 'VP8X': // 扩展格式（动图、带透明度）：宽高各占 3 字节，存的是减 1 后的值
      return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
    default:
      return null;
  }
}

/** JPEG 由一个个段组成，尺寸在 SOF 段里，要逐段往后找 */
function jpegSize(buf: Buffer): [number, number] | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1; // 段之间允许有填充字节
      continue;
    }
    // SOF0–SOF15，排除 0xC4（DHT）、0xC8（保留）、0xCC（DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5)];
    }
    // 这些标记后面没有长度字段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return null;
}

/**
 * 识别图片。只认 PNG、JPEG、GIF、WebP，其他格式（包括 SVG）一律返回 null。
 * 尺寸读不出来或超过上限，也返回 null。
 */
export function inspectImage(head: Buffer): ImageInfo | null {
  let type: ImageType;
  let size: [number, number] | null;
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    type = 'png';
    size = pngSize(head);
  } else if (startsWith(head, [0xff, 0xd8, 0xff])) {
    type = 'jpeg';
    size = jpegSize(head);
  } else if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') {
    type = 'gif';
    size = gifSize(head);
  } else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    type = 'webp';
    size = webpSize(head);
  } else {
    return null;
  }
  if (!size) return null;
  const [width, height] = size;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return null;
  return { type, width, height };
}
