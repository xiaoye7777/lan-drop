// 登录、退出、初始数据和实时推送
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIMITS } from '../../shared/catalog.js';
import type { SessionInfo } from '../../shared/types.js';
import { AVATAR_MAX_BYTES, STICKER_MAX_BYTES } from '../config.js';
import type { AppContext, Route } from '../context.js';
import { isAdmin, isSecure } from '../context.js';
import { cleanLine, clientIp, HttpError, readCookie, readJson, sendJson } from '../http.js';

/**
 * https 和 http 用不同名字的 Cookie。
 * https 的 Cookie 带 Secure 标记，浏览器不会把它发给 http；分开命名，
 * 是为了让 http 登录时写入的 Cookie 不会和 https 的同名 Cookie 冲突（浏览器不允许 http 覆盖 Secure Cookie）。
 */
const SECURE_COOKIE = 'lan_drop_session';
const PLAIN_COOKIE = 'lan_drop_http';

export function sessionCookieName(req: IncomingMessage): string {
  return isSecure(req) ? SECURE_COOKIE : PLAIN_COOKIE;
}

/** 登录失败限制：同一 IP 在时间窗口内失败太多次，就暂时拒绝，防止猜口令 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** 先取哈希再比较，长度不同也能进行定长比较，避免通过响应时间猜口令 */
function safeEqual(a: string, b: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** 昵称被其他在线同事占用时拒绝。不在线的同名账号允许共存，靠 IP 区分 */
export function assertNameAvailable(ctx: AppContext, name: string, selfId?: string): void {
  const taken = ctx.store
    .listUsers()
    .some((user) => user.name === name && user.id !== selfId && ctx.hub.isOnline(user.id));
  if (taken) throw new HttpError(409, '这个昵称正在被其他同事使用，换一个吧');
}

export function authRoutes(ctx: AppContext): Route[] {
  const { config, store, hub } = ctx;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number): void {
    const secure = isSecure(req);
    res.setHeader(
      'Set-Cookie',
      `${sessionCookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const failures = loginFailures.get(ip);
    if (failures && failures.resetAt > Date.now() && failures.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, '尝试次数太多，请 10 分钟后再试');
    }
    const body = await readJson(req);
    if (typeof body.code !== 'string' || !safeEqual(body.code.trim(), config.accessCode)) {
      if (failures && failures.resetAt > Date.now()) failures.count += 1;
      else loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
      throw new HttpError(401, '访问口令不正确');
    }
    const name = cleanLine(body.name, LIMITS.nameLength, '昵称');
    const existing = store.findUserByNameAndIp(name, ip);
    assertNameAvailable(ctx, name, existing?.id);
    const user = existing ?? store.createUser(name, ip);
    setCookie(req, res, store.createSession(user.id), Math.floor(config.sessionTtlMs / 1000));
    ctx.broadcastUsers();
    sendJson(res, 200, { ok: true });
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    const token = readCookie(req, sessionCookieName(req));
    if (token) store.deleteSession(token);
    setCookie(req, res, '', 0);
    sendJson(res, 200, { ok: true });
  }

  function session(req: IncomingMessage, res: ServerResponse): void {
    const user = ctx.requireUser(req);
    // 登录状态在服务器上已经顺延，Cookie 的有效期也一起顺延
    const token = readCookie(req, sessionCookieName(req));
    if (token) setCookie(req, res, token, Math.floor(config.sessionTtlMs / 1000));
    const recent = store.recentFor(user.id, LIMITS.historyPage);
    const body: SessionInfo = {
      me: ctx.toUserInfo(user),
      users: store.listUsers().map(ctx.toUserInfo),
      messages: recent.messages,
      older: recent.older,
      stickers: store.listStickers(),
      limits: {
        maxFileBytes: config.maxFileBytes,
        maxStickerBytes: STICKER_MAX_BYTES,
        maxAvatarBytes: AVATAR_MAX_BYTES,
      },
      remarks: user.remarks ?? {},
      storage: store.storageInfo(),
      admin: isAdmin(req, config),
    };
    sendJson(res, 200, body);
  }

  function events(req: IncomingMessage, res: ServerResponse): void {
    const user = ctx.requireUser(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    if (hub.add(user.id, res)) ctx.broadcastUsers();
    // 要监听 res：Node 16 起 req 的 close 在请求读完时就会触发，并不代表连接断开
    res.on('close', () => {
      if (hub.remove(user.id, res)) ctx.broadcastUsers();
    });
  }

  /** 不用登录就能看的基本信息：服务器有没有加密地址 */
  function info(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, { https: ctx.httpsAvailable });
  }

  return [
    { method: 'GET', path: '/api/info', handler: info },
    { method: 'POST', path: '/api/login', handler: login },
    { method: 'POST', path: '/api/logout', handler: logout },
    { method: 'GET', path: '/api/session', handler: session },
    { method: 'GET', path: '/api/events', handler: events },
  ];
}
