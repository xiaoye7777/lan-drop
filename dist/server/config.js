import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
/** 页面会先把头像裁成 256×256 再上传，正常只有几十 KB */
export const AVATAR_MAX_BYTES = 512 * 1024;
/** 动图表情一般不大，2 MB 足够 */
export const STICKER_MAX_BYTES = 2 * MB;
/** 项目根目录。编译后本文件位于 dist/server/，往上两层就是根目录 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function positiveNumber(raw, fallback, name) {
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`环境变量 ${name} 必须是正数，当前值：${raw}`);
    }
    return value;
}
/** 环境变量是 0、false、off 时为关闭，其他情况（包括没设置）为开启 */
function enabled(raw) {
    return !['0', 'false', 'off'].includes((raw ?? '').trim().toLowerCase());
}
/** 随机生成访问口令，去掉了 0/O、1/I/L 这些容易看错的字符 */
function generateAccessCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i += 1)
        code += alphabet[randomInt(alphabet.length)];
    return code;
}
/** 优先用环境变量；否则读取上次生成的口令；都没有就生成一个并保存，重启后不变 */
function resolveAccessCode(dataDir, fromEnv) {
    if (fromEnv)
        return fromEnv;
    const file = join(dataDir, 'access-code.txt');
    if (existsSync(file)) {
        const saved = readFileSync(file, 'utf8').trim();
        if (saved)
            return saved;
    }
    const code = generateAccessCode();
    writeFileSync(file, `${code}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return code;
}
export function loadConfig(env = process.env) {
    const dataDir = resolve(env.LAN_DROP_DATA_DIR || join(PROJECT_ROOT, 'data'));
    const freshDataDir = !existsSync(join(dataDir, 'users.json'));
    mkdirSync(dataDir, { recursive: true });
    return {
        host: env.LAN_DROP_HOST || undefined,
        port: positiveNumber(env.LAN_DROP_PORT, 8000, 'LAN_DROP_PORT'),
        https: enabled(env.LAN_DROP_HTTPS),
        allowHttp: enabled(env.LAN_DROP_ALLOW_HTTP),
        localAdmin: enabled(env.LAN_DROP_LOCAL_ADMIN),
        dataDir,
        freshDataDir,
        accessCode: resolveAccessCode(dataDir, env.LAN_DROP_CODE),
        maxFileBytes: positiveNumber(env.LAN_DROP_MAX_FILE_MB, 20, 'LAN_DROP_MAX_FILE_MB') * MB,
        maxStorageBytes: positiveNumber(env.LAN_DROP_MAX_STORAGE_GB, 10, 'LAN_DROP_MAX_STORAGE_GB') * 1024 * MB,
        sessionTtlMs: 30 * DAY,
    };
}
