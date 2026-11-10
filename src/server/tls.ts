// 生成 HTTPS 用的自签名证书。
//
// Node 能生成密钥和签名，但没有生成证书的接口；为了不依赖 openssl 命令（Windows 上通常没有），
// 这里按 X.509 标准手工拼出证书的二进制结构（DER 编码），再用私钥签名。
// 证书是自己签发的，浏览器第一次访问会提示“不安全”，选择继续访问即可；
// 连接本身仍然是加密的，局域网里的其他人看不到传输内容。
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
/** 有效期不超过 398 天，这是浏览器对服务器证书有效期的上限 */
const VALID_DAYS = 397;
/** 离到期不足这么多天就提前换新证书 */
const RENEW_BEFORE_DAYS = 30;

export interface TlsMaterial {
  key: string;
  cert: string;
  /** SHA-256 指纹，同事可以在浏览器的证书详情里核对，确认连上的是这台服务器 */
  fingerprint: string;
}

// ---------- DER 编码：每个值都是“类型标签 + 长度 + 内容” ----------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octetString = (value: Buffer) => tlv(0x04, value);
const utf8String = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
/** [n] EXPLICIT：带编号的外层包装，证书里的版本号和扩展字段用到 */
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
const TRUE = tlv(0x01, Buffer.from([0xff]));

/** unusedBits：最后一个字节里没用到的位数 */
function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), value);
}

/** 对象标识符，例如 2.5.4.3 表示“通用名称” */
function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let n = Math.floor(value / 128); n > 0; n = Math.floor(n / 128)) chunk.unshift((n & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** 正整数：去掉多余的前导 0；最高位是 1 时要补一个 0，否则会被当成负数 */
function positiveInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  let body = value.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

/** 2050 年以前用 UTCTime（两位年份），之后用 GeneralizedTime（四位年份） */
function time(date: Date): Buffer {
  const compact = `${date.toISOString().slice(0, 19).replace(/[-:T]/g, '')}Z`;
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(compact.slice(2))) : tlv(0x18, Buffer.from(compact));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [TRUE] : []), octetString(value));
}

function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (ip === '::1') return Buffer.from([...new Array<number>(15).fill(0), 1]);
  throw new Error(`不支持的地址：${ip}`);
}

function toPem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * 生成一张自签名证书。
 * 浏览器只看“使用者备用名称”（SAN）判断证书属于哪个地址，所以本机的每个 IP 和主机名都要写进去。
 */
export function createCertificate(ips: string[], dnsNames: string[], now = Date.now()): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8String('lan-drop')))); // CN=lan-drop
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x10; // 序列号必须是正数且不为 0

  const subjectAltName = sequence(
    ...ips.map((ip) => tlv(0x87, ipBytes(ip))), // [7] IP 地址
    ...dnsNames.map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))), // [2] 域名
  );

  const tbsCertificate = sequence(
    explicit(0, positiveInteger(Buffer.from([2]))), // 版本 v3
    positiveInteger(serial),
    algorithm,
    name, // 签发者
    sequence(time(new Date(now - DAY)), time(new Date(now + VALID_DAYS * DAY))), // 有效期，往前留一天防止电脑时间不准
    name, // 使用者：自签名，所以和签发者相同
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      sequence(
        extension('2.5.29.19', true, sequence()), // 基本约束：不是 CA，不能用来签发别的证书
        extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)), // 密钥用途：数字签名
        extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))), // 扩展用途：网站服务器
        extension('2.5.29.17', false, subjectAltName),
      ),
    ),
  );

  const signature = sign('sha256', tbsCertificate, { key: privateKey, dsaEncoding: 'der' });
  const certificate = sequence(tbsCertificate, algorithm, bitString(signature));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: toPem(certificate),
  };
}

/** 现有证书还能不能用：没过期、不会很快过期、覆盖了当前所有地址 */
function isUsable(cert: X509Certificate, ips: string[], dnsNames: string[]): boolean {
  if (new Date(cert.validTo).getTime() - Date.now() < RENEW_BEFORE_DAYS * DAY) return false;
  return ips.every((ip) => cert.checkIP(ip)) && dnsNames.every((name) => cert.checkHost(name));
}

/**
 * 读取保存的证书；没有、快过期或者本机 IP 变了，就重新生成。
 * 证书换新后，同事的浏览器会再提示一次“不安全”。
 */
export function loadOrCreateCertificate(dir: string, ips: string[], dnsNames: string[]): TlsMaterial & { created: boolean } {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    try {
      const parsed = new X509Certificate(cert);
      if (isUsable(parsed, ips, dnsNames)) return { key, cert, fingerprint: parsed.fingerprint256, created: false };
    } catch {
      // 证书文件损坏，重新生成
    }
  }

  const { key, cert } = createCertificate(ips, dnsNames);
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(certPath, cert, { mode: 0o600 });
  return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256, created: true };
}
