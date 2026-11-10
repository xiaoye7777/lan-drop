// 登录、退出、初始数据和实时推送
import { createHash, timingSafeEqual } from 'node:crypto';
import { LIMITS } from '../../shared/catalog.js';
import { AVATAR_MAX_BYTES, STICKER_MAX_BYTES } from '../config.js';
import { cleanLine, clientIp, HttpError, readCookie, readJson, sendJson } from '../http.js';
export const COOKIE_NAME = 'lan_drop_session';
/** 登录失败限制：同一 IP 在时间窗口内失败太多次，就暂时拒绝，防止猜口令 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** 先取哈希再比较，长度不同也能进行定长比较，避免通过响应时间猜口令 */
function safeEqual(a, b) {
    const hash = (value) => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(a), hash(b));
}
/** 昵称被其他在线同事占用时拒绝。不在线的同名账号允许共存，靠 IP 区分 */
export function assertNameAvailable(ctx, name, selfId) {
    const taken = ctx.store
        .listUsers()
        .some((user) => user.name === name && user.id !== selfId && ctx.hub.isOnline(user.id));
    if (taken)
        throw new HttpError(409, '这个昵称正在被其他同事使用，换一个吧');
}
export function authRoutes(ctx) {
    const { config, store, hub } = ctx;
    const loginFailures = new Map();
    function cookie(value, maxAge) {
        return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ctx.secure ? '; Secure' : ''}`;
    }
    async function login(req, res) {
        const ip = clientIp(req);
        const failures = loginFailures.get(ip);
        if (failures && failures.resetAt > Date.now() && failures.count >= LOGIN_MAX_FAILURES) {
            throw new HttpError(429, '尝试次数太多，请 10 分钟后再试');
        }
        const body = await readJson(req);
        if (typeof body.code !== 'string' || !safeEqual(body.code.trim(), config.accessCode)) {
            if (failures && failures.resetAt > Date.now())
                failures.count += 1;
            else
                loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
            throw new HttpError(401, '访问口令不正确');
        }
        const name = cleanLine(body.name, LIMITS.nameLength, '昵称');
        const existing = store.findUserByNameAndIp(name, ip);
        assertNameAvailable(ctx, name, existing?.id);
        const user = existing ?? store.createUser(name, ip);
        res.setHeader('Set-Cookie', cookie(store.createSession(user.id), Math.floor(config.sessionTtlMs / 1000)));
        ctx.broadcastUsers();
        sendJson(res, 200, { ok: true });
    }
    function logout(req, res) {
        const token = readCookie(req, COOKIE_NAME);
        if (token)
            store.deleteSession(token);
        res.setHeader('Set-Cookie', cookie('', 0));
        sendJson(res, 200, { ok: true });
    }
    function session(req, res) {
        const user = ctx.requireUser(req);
        const body = {
            me: ctx.toUserInfo(user),
            users: store.listUsers().map(ctx.toUserInfo),
            messages: store.messagesFor(user.id),
            stickers: store.listStickers(),
            limits: {
                maxFileBytes: config.maxFileBytes,
                maxStickerBytes: STICKER_MAX_BYTES,
                maxAvatarBytes: AVATAR_MAX_BYTES,
            },
        };
        sendJson(res, 200, body);
    }
    function events(req, res) {
        const user = ctx.requireUser(req);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        if (hub.add(user.id, res))
            ctx.broadcastUsers();
        // 要监听 res：Node 16 起 req 的 close 在请求读完时就会触发，并不代表连接断开
        res.on('close', () => {
            if (hub.remove(user.id, res))
                ctx.broadcastUsers();
        });
    }
    return [
        { method: 'POST', path: '/api/login', handler: login },
        { method: 'POST', path: '/api/logout', handler: logout },
        { method: 'GET', path: '/api/session', handler: session },
        { method: 'GET', path: '/api/events', handler: events },
    ];
}
