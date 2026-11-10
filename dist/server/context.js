import { clientIp } from './http.js';
/** 路径里的 id 都是 randomUUID 生成的，格式固定 */
export const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
/** 这个请求是不是通过 HTTPS 来的。同一个端口上 HTTPS 和 HTTP 都能访问，要按请求判断 */
export function isSecure(req) {
    return req.socket.encrypted === true;
}
/**
 * 是不是在服务器电脑上用 localhost 打开的。这样打开的人可以清理任何人的文件：
 * 能操作服务器电脑的人本来就能直接看到 data 目录里的所有数据，给他这个权限不会多暴露什么。
 * 如果在前面加了反向代理（所有请求都像是从本机来的），要用 LAN_DROP_LOCAL_ADMIN=0 关掉。
 */
export function isAdmin(req, config) {
    if (!config.localAdmin)
        return false;
    const ip = clientIp(req);
    return ip === '127.0.0.1' || ip === '::1';
}
