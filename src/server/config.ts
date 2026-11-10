import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

/** 页面会先把头像裁成 256×256 再上传，正常只有几十 KB */
export const AVATAR_MAX_BYTES = 512 * 1024;
/** 动图表情一般不大，2 MB 足够 */
export const STICKER_MAX_BYTES = 2 * MB;

export interface Config {
  /** 不设置时同时监听 IPv4 和 IPv6 */
  host?: string;
  port: number;
  /** 默认开启。关闭后用 HTTP 明文传输，局域网里的人可以看到聊天内容 */
  https: boolean;
  dataDir: string;
  accessCode: string;
  maxFileBytes: number;
  /** 所有未过期文件的总容量上限 */
  maxStorageBytes: number;
  fileTtlMs: number;
  messageTtlMs: number;
  sessionTtlMs: number;
}

/** 项目根目录。编译后本文件位于 dist/server/，往上两层就是根目录 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正数，当前值：${raw}`);
  }
  return value;
}

/** 随机生成访问口令，去掉了 0/O、1/I/L 这些容易看错的字符 */
function generateAccessCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}

/** 优先用环境变量；否则读取上次生成的口令；都没有就生成一个并保存，重启后不变 */
function resolveAccessCode(dataDir: string, fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const file = join(dataDir, 'access-code.txt');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }
  const code = generateAccessCode();
  writeFileSync(file, `${code}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return code;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.LAN_DROP_DATA_DIR || join(PROJECT_ROOT, 'data'));
  mkdirSync(dataDir, { recursive: true });

  const fileTtlMs = positiveNumber(env.LAN_DROP_FILE_TTL_HOURS, 24, 'LAN_DROP_FILE_TTL_HOURS') * HOUR;

  return {
    host: env.LAN_DROP_HOST || undefined,
    port: positiveNumber(env.LAN_DROP_PORT, 8000, 'LAN_DROP_PORT'),
    https: !['0', 'false', 'off'].includes((env.LAN_DROP_HTTPS ?? '').toLowerCase()),
    dataDir,
    accessCode: resolveAccessCode(dataDir, env.LAN_DROP_CODE),
    maxFileBytes: positiveNumber(env.LAN_DROP_MAX_FILE_MB, 20, 'LAN_DROP_MAX_FILE_MB') * MB,
    maxStorageBytes: positiveNumber(env.LAN_DROP_MAX_STORAGE_GB, 2, 'LAN_DROP_MAX_STORAGE_GB') * 1024 * MB,
    fileTtlMs,
    // 消息至少要活得比文件久，否则文件还没过期，消息先没了
    messageTtlMs: Math.max(7 * DAY, fileTtlMs),
    sessionTtlMs: 30 * DAY,
  };
}
