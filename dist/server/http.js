const MAX_JSON_BYTES = 64 * 1024;
/** 路由里抛出这个错误，会被统一转换成 JSON 错误响应 */
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}
export async function readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_JSON_BYTES)
            throw new HttpError(413, '内容太长');
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // 走到下面统一报错
    }
    throw new HttpError(400, '请求格式不正确');
}
/**
 * 检查上传请求声明的大小。必须带 Content-Length：
 * Node 不会读取超过这个长度的内容，所以提前检查它，就能保证实际收到的数据不超限。
 */
export function declaredLength(req, max) {
    const raw = req.headers['content-length'];
    const length = Number(raw);
    if (raw === undefined || !Number.isInteger(length) || length < 0)
        throw new HttpError(411, '缺少文件大小');
    if (length > max)
        throw new HttpError(413, `文件不能超过 ${formatMb(max)}`);
    return length;
}
/** 读取整个请求体。只用于头像、表情这类小文件，调用前要先用 declaredLength 限制大小 */
export async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}
export function formatMb(bytes) {
    const mb = bytes / 1024 / 1024;
    return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.round(bytes / 1024)} KB`;
}
export function readCookie(req, name) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name)
            return rest.join('=');
    }
    return undefined;
}
/** 去掉 IPv4 映射地址的前缀，让 ::ffff:192.168.1.2 显示成 192.168.1.2 */
export function clientIp(req) {
    return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}
/** 去掉控制字符和不可见的格式字符，后者可以把 a.exe 伪装显示成 exe.a 这样的文件名 */
export function stripInvisible(value) {
    return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}
/** 清理一段单行文字：必须是字符串，去掉不可见字符，限制长度。允许为空时返回空字符串 */
export function cleanLine(value, maxLength, label, allowEmpty = false) {
    if (value === undefined && allowEmpty)
        return '';
    if (typeof value !== 'string')
        throw new HttpError(400, `${label}格式不正确`);
    const text = stripInvisible(value);
    if (!text && !allowEmpty)
        throw new HttpError(400, `请填写${label}`);
    if ([...text].length > maxLength)
        throw new HttpError(400, `${label}不能超过 ${maxLength} 个字`);
    return text;
}
/** 按 RFC 5987 编码文件名，这样中文文件名下载时不会乱码 */
export function contentDisposition(kind, fileName) {
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${kind}; filename="download"; filename*=UTF-8''${encoded}`;
}
export const IMAGE_MIME = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};
/**
 * 返回同事上传的图片时用的响应头。
 * 除了声明准确的图片类型，还用 CSP 的 sandbox 禁止它作为页面运行：
 * 即使有人把网页伪装成图片上传，直接打开这个地址也执行不了任何脚本。
 */
export function imageHeaders(type, size, cacheControl) {
    return {
        'Content-Type': IMAGE_MIME[type],
        'Content-Length': size,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
        'Cache-Control': cacheControl,
    };
}
