import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ChatMessage, ServerEvent, SessionInfo, UserInfo } from '../shared/types.js';
import { PROJECT_ROOT } from './config.js';
import type { Config } from './config.js';
import { EventHub } from './events.js';
import { GROUP_RECIPIENT, Store } from './store.js';
import type { StoredUser } from './store.js';

const COOKIE_NAME = 'lan_drop_session';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 5000;
const MAX_NAME_LENGTH = 20;
const MAX_FILE_NAME_LENGTH = 200;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** 登录失败限制：同一 IP 在时间窗口内失败太多次，就暂时拒绝，防止猜口令 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** 路由里抛出这个错误，会被统一转换成 JSON 错误响应 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface App {
  server: Server;
  store: Store;
  close(): Promise<void>;
}

// ---------- 通用小工具 ----------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new HttpError(413, '内容太长');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 走到下面统一报错
  }
  throw new HttpError(400, '请求格式不正确');
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** 去掉 IPv4 映射地址的前缀，让 ::ffff:192.168.1.2 显示成 192.168.1.2 */
function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

/** 先取哈希再比较，长度不同也能进行定长比较，避免通过响应时间猜口令 */
function safeEqual(a: string, b: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** 去掉控制字符和不可见的格式字符，后者可以把 a.exe 伪装显示成 exe.a 这样的文件名 */
function stripInvisible(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, '请填写昵称');
  const name = stripInvisible(value);
  if (!name) throw new HttpError(400, '请填写昵称');
  if ([...name].length > MAX_NAME_LENGTH) throw new HttpError(400, `昵称不能超过 ${MAX_NAME_LENGTH} 个字`);
  return name;
}

/** 文件名来自用户输入：去掉路径和控制字符，只保留可以显示的部分 */
function cleanFileName(value: string | null): string {
  const base = (value ?? '').split(/[\\/]/).pop() ?? '';
  const name = stripInvisible(base);
  return [...name].slice(0, MAX_FILE_NAME_LENGTH).join('') || '未命名文件';
}

/** 按 RFC 5987 编码文件名，这样中文文件名下载时不会乱码 */
function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

/** 只允许固定的几个静态文件，请求路径不会参与文件路径拼接，因此不存在目录穿越 */
function buildStaticFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of [join(PROJECT_ROOT, 'public'), join(PROJECT_ROOT, 'dist', 'web')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (MIME_TYPES[extname(name)]) files.set(`/${name}`, join(dir, name));
    }
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

export function createApp(config: Config): App {
  const store = new Store(config);
  const hub = new EventHub();
  const staticFiles = buildStaticFiles();
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

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

  // ---------- 数据转换 ----------

  const toUserInfo = (user: StoredUser): UserInfo => ({
    id: user.id,
    name: user.name,
    ip: user.ip,
    online: hub.isOnline(user.id),
  });

  const allUsers = (): UserInfo[] => store.listUsers().map(toUserInfo);

  const broadcastUsers = (): void => hub.broadcast({ type: 'users', users: allUsers() });

  /** 把新消息推送给能看到它的人 */
  function publish(message: ChatMessage): void {
    const event: ServerEvent = { type: 'message', message };
    if (message.to === GROUP_RECIPIENT) hub.broadcast(event);
    else hub.sendTo([message.from, message.to], event);
  }

  // ---------- 登录相关 ----------

  function checkLoginAllowed(ip: string): void {
    const entry = loginFailures.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, '尝试次数太多，请 10 分钟后再试');
    }
  }

  function recordLoginFailure(ip: string): void {
    const now = Date.now();
    const entry = loginFailures.get(ip);
    if (entry && entry.resetAt > now) entry.count += 1;
    else loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  }

  function requireUser(req: IncomingMessage): StoredUser {
    const token = readCookie(req, COOKIE_NAME);
    const user = token ? store.authenticate(token, clientIp(req)) : undefined;
    if (!user) throw new HttpError(401, '请先登录');
    return user;
  }

  /** 防止其他网站借用同事浏览器里的 Cookie 发请求。浏览器发 POST 时一定会带 Origin */
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin) return;
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      // 格式不对，按不匹配处理
    }
    if (originHost !== req.headers.host) throw new HttpError(403, '请求来源不被允许');
  }

  /** 昵称被其他在线同事占用时拒绝。不在线的同名账号允许共存，靠 IP 区分 */
  function assertNameAvailable(name: string, selfId?: string): void {
    const taken = store.listUsers().some(
      (user) => user.name === name && user.id !== selfId && hub.isOnline(user.id),
    );
    if (taken) throw new HttpError(409, '这个昵称正在被其他同事使用，换一个吧');
  }

  // ---------- 路由 ----------

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    checkLoginAllowed(ip);
    const body = await readJson(req);
    if (typeof body.code !== 'string' || !safeEqual(body.code.trim(), config.accessCode)) {
      recordLoginFailure(ip);
      throw new HttpError(401, '访问口令不正确');
    }
    const name = cleanName(body.name);
    const existing = store.findUserByNameAndIp(name, ip);
    assertNameAvailable(name, existing?.id);
    const user = existing ?? store.createUser(name, ip);
    const token = store.createSession(user.id);
    const maxAge = Math.floor(config.sessionTtlMs / 1000);
    // 内网用 HTTP 访问，所以不能加 Secure 标记
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
    broadcastUsers();
    sendJson(res, 200, { ok: true });
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    const token = readCookie(req, COOKIE_NAME);
    if (token) store.deleteSession(token);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    sendJson(res, 200, { ok: true });
  }

  function getSession(req: IncomingMessage, res: ServerResponse): void {
    const user = requireUser(req);
    const session: SessionInfo = {
      me: toUserInfo(user),
      users: allUsers(),
      messages: store.messagesFor(user.id),
      maxFileBytes: config.maxFileBytes,
    };
    sendJson(res, 200, session);
  }

  async function rename(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = requireUser(req);
    const name = cleanName((await readJson(req)).name);
    assertNameAvailable(name, user.id);
    store.renameUser(user, name);
    broadcastUsers();
    sendJson(res, 200, { ok: true });
  }

  function openEventStream(req: IncomingMessage, res: ServerResponse): void {
    const user = requireUser(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    if (hub.add(user.id, res)) broadcastUsers();
    // 要监听 res：Node 16 起 req 的 close 在请求读完时就会触发，并不代表连接断开
    res.on('close', () => {
      if (hub.remove(user.id, res)) broadcastUsers();
    });
  }

  async function postMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = requireUser(req);
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '消息不能为空');
    if (text.length > MAX_TEXT_LENGTH) throw new HttpError(400, `消息不能超过 ${MAX_TEXT_LENGTH} 个字`);
    const to = typeof body.to === 'string' ? body.to : '';
    if (!store.isValidRecipient(to)) throw new HttpError(400, '找不到接收人');
    const message = store.addMessage(user, to, { text });
    publish(message);
    sendJson(res, 200, message);
  }

  /**
   * 上传文件。请求体就是文件的原始字节，接收人和文件名放在查询参数里。
   * 必须带 Content-Length：Node 不会读取超过这个长度的内容，
   * 所以只要提前检查这个值，就能保证文件大小不会超限。
   */
  async function uploadFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const user = requireUser(req);
    const to = url.searchParams.get('to') ?? '';
    if (!store.isValidRecipient(to)) throw new HttpError(400, '找不到接收人');

    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] === undefined || !Number.isInteger(declared) || declared < 0) {
      throw new HttpError(411, '缺少文件大小');
    }
    if (declared > config.maxFileBytes) {
      throw new HttpError(413, `文件不能超过 ${Math.floor(config.maxFileBytes / 1024 / 1024)} MB`);
    }
    if (!store.reserveStorage(declared)) throw new HttpError(507, '服务器空间已满，请稍后再试');

    const tempPath = store.newTempFilePath();
    try {
      await pipeline(req, createWriteStream(tempPath, { mode: 0o600 }));
      const fileId = randomUUID();
      // 改名和写入消息在同一轮同步代码里完成，定期清理不会把这个文件当成残留删掉
      renameSync(tempPath, store.filePath(fileId));
      const message = store.addMessage(user, to, {
        file: {
          id: fileId,
          name: cleanFileName(url.searchParams.get('name')),
          size: declared,
          expiresAt: Date.now() + config.fileTtlMs,
        },
      });
      publish(message);
      sendJson(res, 200, message);
    } catch (error) {
      // 对方取消上传或网络中断时，清掉传了一半的文件
      rmSync(tempPath, { force: true });
      throw error;
    } finally {
      store.releaseStorage(declared);
    }
  }

  /**
   * 下载文件。一律按附件下载，并声明为二进制内容：
   * 否则有人上传一个 HTML，浏览器可能直接执行里面的脚本。
   */
  async function downloadFile(req: IncomingMessage, res: ServerResponse, fileId: string): Promise<void> {
    const user = requireUser(req);
    const message = store.findFile(fileId);
    // 没有权限和不存在返回同样的结果，不暴露文件是否存在
    if (!message?.file || !store.canView(message, user.id)) throw new HttpError(404, '文件不存在');
    const path = store.filePath(fileId);
    if (message.file.expiresAt <= Date.now() || !existsSync(path)) throw new HttpError(410, '文件已过期');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': message.file.size,
      'Content-Disposition': contentDisposition(message.file.name),
      'Cache-Control': 'no-store',
    });
    await pipeline(createReadStream(path), res);
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const path = staticFiles.get(pathname);
    if (!path) throw new HttpError(404, '页面不存在');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(path)],
      'Cache-Control': 'no-cache',
    });
    res.end(readFileSync(path));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);

    switch (`${req.method} ${pathname}`) {
      case 'POST /api/login':
        return login(req, res);
      case 'POST /api/logout':
        return logout(req, res);
      case 'GET /api/session':
        return getSession(req, res);
      case 'POST /api/me':
        return rename(req, res);
      case 'GET /api/events':
        return openEventStream(req, res);
      case 'POST /api/messages':
        return postMessage(req, res);
      case 'POST /api/files':
        return uploadFile(req, res, url);
    }

    const fileMatch = /^\/api\/files\/([0-9a-f-]{36})$/.exec(pathname);
    if (req.method === 'GET' && fileMatch) return downloadFile(req, res, fileMatch[1]);
    if (pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在');
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
    throw new HttpError(405, '不支持的请求方式');
  }

  const server = createServer((req, res) => {
    // 只允许加载本站资源，并禁止被其他页面嵌入
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

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
  });

  return {
    server,
    store,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweepTimer);
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
