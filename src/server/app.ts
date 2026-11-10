// 组装整个服务：安全响应头、路由分发、静态页面，以及 HTTPS 和 HTTP 共用一个端口的处理
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { extname, join } from 'node:path';
import type { ChatMessage, ServerEvent, UserInfo } from '../shared/types.js';
import { PROJECT_ROOT } from './config.js';
import type { Config } from './config.js';
import type { AppContext, Route } from './context.js';
import { isSecure } from './context.js';
import { EventHub } from './events.js';
import { clientIp, HttpError, readCookie, sendJson } from './http.js';
import { authRoutes, sessionCookieName } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { messageRoutes } from './routes/messages.js';
import { profileRoutes } from './routes/profile.js';
import { GROUP_RECIPIENT, Store } from './store.js';
import type { StoredUser } from './store.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** 连上来却一直不发数据的连接，等这么久就断开 */
const FIRST_BYTE_TIMEOUT_MS = 30_000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * 页面的安全策略：只允许加载本站资源，禁止被其他页面嵌入。
 * img-src 额外允许 blob:，用于显示自己电脑上选的聊天背景图（图片不会上传）。
 */
const PAGE_CSP =
  "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface App {
  /** 对外监听的服务器。开启 HTTPS 时，同一个端口上的 HTTPS 和 HTTP 请求分别交给对应的处理器 */
  server: Server;
  store: Store;
  close(): Promise<void>;
}

/**
 * 只允许固定的静态文件，请求路径不会参与文件路径拼接，因此不存在目录穿越。
 * 前端脚本在 dist/web，前后端共用的数据在 dist/shared，页面通过 /shared/ 引用。
 */
function buildStaticFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const dirs: [string, string][] = [
    [join(PROJECT_ROOT, 'public'), '/'],
    [join(PROJECT_ROOT, 'dist', 'web'), '/'],
    [join(PROJECT_ROOT, 'dist', 'shared'), '/shared/'],
  ];
  for (const [dir, prefix] of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (MIME_TYPES[extname(name)]) files.set(`${prefix}${name}`, join(dir, name));
    }
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

/**
 * 防止其他网站借用同事浏览器里的 Cookie 发请求。浏览器发 POST 时一定会带 Origin。
 * 协议也要一致：http:// 的页面不能操作 https:// 的登录状态，反过来也一样
 */
function checkOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host ?? ''}`;
  if (origin !== expected) throw new HttpError(403, '请求来源不被允许');
}

/** 设置了只允许 HTTPS 时，有人用 http:// 访问，就告诉浏览器改用 https:// */
function redirectToHttps(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host ?? '';
  // Host 头只允许出现主机名、IP 和端口，防止被拼出奇怪的跳转地址
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) {
    res.writeHead(400).end();
    return;
  }
  const path = req.url?.startsWith('/') ? req.url : '/';
  // 用 307 而不是 301：301 会被浏览器永久缓存，以后关掉 HTTPS 就回不去了
  res.writeHead(307, { Location: `https://${host}${path}`, 'Cache-Control': 'no-store' }).end();
}

export function createApp(config: Config, options: { tls?: { key: string; cert: string } } = {}): App {
  const store = new Store(config);
  const hub = new EventHub();
  const staticFiles = buildStaticFiles();
  store.onStorageChange = (storage) => hub.broadcast({ type: 'storage', storage });

  store.sweep();
  const sweepTimer = setInterval(() => {
    // 清理失败（比如文件正被占用）不能让整个服务崩溃，下一轮会再试
    try {
      store.sweep();
    } catch (error) {
      console.error('定期清理失败：', error);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // ---------- 各路由共用的服务 ----------

  const toUserInfo = (user: StoredUser): UserInfo => ({
    id: user.id,
    name: user.name,
    ip: user.ip,
    online: hub.isOnline(user.id),
    avatar: user.avatar?.version ?? null,
    bio: user.bio ?? '',
    nameplate: user.nameplate ?? 'default',
    bubble: user.bubble ?? 'default',
    nudgeSuffix: user.nudgeSuffix ?? '',
  });

  /** 全组消息推给所有人，私聊只推给双方 */
  const sendToAudience = (message: ChatMessage, event: ServerEvent): void => {
    if (message.to === GROUP_RECIPIENT) hub.broadcast(event);
    else hub.sendTo([message.from, message.to], event);
  };

  const ctx: AppContext = {
    config,
    store,
    hub,
    httpsAvailable: Boolean(options.tls),
    requireUser(req: IncomingMessage): StoredUser {
      const token = readCookie(req, sessionCookieName(req));
      const user = token ? store.authenticate(token, clientIp(req)) : undefined;
      if (!user) throw new HttpError(401, '请先登录');
      return user;
    },
    requireStorage(): void {
      if (store.isStorageFull()) throw new HttpError(507, '存储空间已满，暂时不能发送。请先清理一些文件');
    },
    toUserInfo,
    publish(message: ChatMessage): void {
      sendToAudience(message, { type: 'message', message });
    },
    publishDeleted(message: ChatMessage): void {
      sendToAudience(message, { type: 'deleted', id: message.id });
    },
    broadcastUsers(): void {
      hub.broadcast({ type: 'users', users: store.listUsers().map(toUserInfo) });
    },
    broadcastStickers(): void {
      hub.broadcast({ type: 'stickers', stickers: store.listStickers() });
    },
  };

  const routes: Route[] = [...authRoutes(ctx), ...messageRoutes(ctx), ...fileRoutes(ctx), ...profileRoutes(ctx)];

  // ---------- 路由分发 ----------

  function serveStatic(res: ServerResponse, pathname: string): void {
    const path = staticFiles.get(pathname);
    if (!path) throw new HttpError(404, '页面不存在');
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(path)], 'Cache-Control': 'no-cache' });
    res.end(readFileSync(path));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);

    for (const item of routes) {
      if (item.method !== req.method) continue;
      if (typeof item.path === 'string') {
        if (item.path === pathname) return item.handler(req, res, { url, match: [pathname] });
      } else {
        const match = item.path.exec(pathname);
        if (match) return item.handler(req, res, { url, match: [...match] });
      }
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在');
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
    throw new HttpError(405, '不支持的请求方式');
  }

  const handler: RequestListener = (req, res) => {
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // 注意：不能发 HSTS。证书是自签名的，HSTS 会让浏览器不再允许“继续访问”

    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        // 响应已经发出一部分（比如下载中断），只能直接断开
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError) && !req.destroyed) console.error('请求处理失败：', error);
      // 请求体可能还没读完（比如文件超限），响应后要关闭连接，不能继续接收
      if (!req.complete) res.setHeader('Connection', 'close');
      res.once('finish', () => {
        if (!req.complete) req.destroy();
      });
      sendJson(res, status, { error: error instanceof HttpError ? error.message : '服务器内部错误' });
    });
  };

  // ---------- 监听 ----------

  let server: Server;
  let closeConnections: () => void;

  if (options.tls) {
    const secure = createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler);
    // http:// 默认也能正常使用（有的同事打不开自签名证书的网站）；关掉后一律跳转到 https://
    const plain = createHttpServer(config.allowHttp ? handler : redirectToHttps);
    const sockets = new Set<Socket>();
    /**
     * 同一个端口同时接收 HTTPS 和 HTTP：看连接发来的第一个字节，
     * TLS 握手总是以 0x16 开头，是的话交给 HTTPS，否则交给 HTTP。
     * 读出来的字节要放回去，让后面的处理器能完整读到。
     */
    server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // 连接异常断开时不让进程崩溃，具体处理交给后面的服务器
      socket.on('error', () => undefined);
      socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => socket.destroy());
      socket.once('data', (chunk: Buffer) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(chunk);
        (chunk[0] === 0x16 ? secure : plain).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    closeConnections = () => sockets.forEach((socket) => socket.destroy());
  } else {
    const plain = createHttpServer(handler);
    server = plain;
    closeConnections = () => plain.closeAllConnections();
  }

  return {
    server,
    store,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweepTimer);
        hub.close();
        server.close(() => resolve());
        closeConnections();
      }),
  };
}
