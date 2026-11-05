// 服务端集成测试：真实启动 HTTP 服务器，用真实请求验证行为。
// 运行：npm test
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server/app.js';
import type { App } from '../server/app.js';
import type { Config } from '../server/config.js';
import type { ChatMessage, SessionInfo } from '../shared/types.js';

const CODE = 'test-access-code';
const MB = 1024 * 1024;
const dataDirs: string[] = [];

after(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lan-drop-test-'));
  dataDirs.push(dir);
  return dir;
}

interface Running {
  app: App;
  base: string;
  port: number;
  dataDir: string;
}

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const dataDir = overrides.dataDir ?? newDataDir();
  const app = createApp({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    accessCode: CODE,
    maxFileBytes: 20 * MB,
    maxStorageBytes: 100 * MB,
    fileTtlMs: 60 * 60 * 1000,
    messageTtlMs: 7 * 24 * 60 * 60 * 1000,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, port, dataDir };
}

function postJson(base: string, path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function login(base: string, name: string): Promise<string> {
  const res = await postJson(base, '/api/login', { name, code: CODE });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function session(base: string, cookie: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as SessionInfo;
}

async function upload(
  base: string,
  cookie: string,
  to: string,
  name: string,
  content: Buffer | string,
): Promise<Response> {
  const query = new URLSearchParams({ to, name });
  return fetch(`${base}/api/files?${query}`, { method: 'POST', headers: { Cookie: cookie }, body: content });
}

/** 打开事件流，持续收集收到的内容 */
async function subscribe(base: string, cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(res.status, 200);
  let received = '';
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += value;
      }
    } catch {
      // 测试结束主动断开时会走到这里
    }
  })();
  return { read: () => received, close: () => controller.abort() };
}

test('口令错误不能登录，未登录不能访问接口', async () => {
  const { app, base } = await start();
  const wrong = await postJson(base, '/api/login', { name: '张三', code: 'wrong' });
  assert.equal(wrong.status, 401);
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'hi' })).status, 401);
  await app.close();
});

test('连续输错口令会被限制，正确口令此时也不行', async () => {
  const { app, base } = await start();
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await postJson(base, '/api/login', { name: '张三', code: 'wrong' })).status, 401);
  }
  assert.equal((await postJson(base, '/api/login', { name: '张三', code: CODE })).status, 429);
  await app.close();
});

test('昵称校验：不能为空、不能过长、不能改成在线同事的昵称', async () => {
  const { app, base } = await start();
  assert.equal((await postJson(base, '/api/login', { name: '   ', code: CODE })).status, 400);
  assert.equal((await postJson(base, '/api/login', { name: '名'.repeat(21), code: CODE })).status, 400);

  // 同一台电脑同一昵称重新登录，身份不变
  const first = await login(base, '张三');
  const again = await login(base, '张三');
  assert.equal((await session(base, first)).me.id, (await session(base, again)).me.id);

  const other = await login(base, '李四');
  const stream = await subscribe(base, first);
  assert.equal((await postJson(base, '/api/me', { name: '张三' }, other)).status, 409);
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // 张三离线后，这个昵称可以被使用
  assert.equal((await postJson(base, '/api/me', { name: '张三' }, other)).status, 200);
  await app.close();
});

test('全组消息所有人可见，私聊第三人看不到', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = (await session(base, b)).me.id;

  assert.equal((await postJson(base, '/api/messages', { to: 'all', text: '大家好' }, a)).status, 200);
  assert.equal((await postJson(base, '/api/messages', { to: bId, text: '私聊内容' }, a)).status, 200);

  const textsFor = async (cookie: string) => (await session(base, cookie)).messages.map((m) => m.text);
  assert.deepEqual(await textsFor(a), ['大家好', '私聊内容']);
  assert.deepEqual(await textsFor(b), ['大家好', '私聊内容']);
  assert.deepEqual(await textsFor(c), ['大家好']);

  assert.equal((await postJson(base, '/api/messages', { to: 'nobody', text: 'x' }, a)).status, 400);
  assert.equal((await postJson(base, '/api/messages', { to: 'all', text: '   ' }, a)).status, 400);
  await app.close();
});

test('文件上传下载内容一致，中文文件名正确，强制按附件下载', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const content = '<script>alert(1)</script>';

  const res = await upload(base, a, 'all', '测试 报告(最终).html', content);
  assert.equal(res.status, 200);
  const message = (await res.json()) as ChatMessage;
  assert.equal(message.file?.size, Buffer.byteLength(content));

  const download = await fetch(`${base}/api/files/${message.file?.id}`, { headers: { Cookie: b } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), content);
  // 上传的 HTML 不能被浏览器当网页执行
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  const disposition = download.headers.get('content-disposition') ?? '';
  assert.match(disposition, /^attachment;/);
  assert.ok(disposition.includes(`filename*=UTF-8''%E6%B5%8B%E8%AF%95%20`), disposition);
  assert.ok(disposition.includes('%28'), '括号要转义');
  await app.close();
});

test('文件名里的路径和不可见字符会被去掉', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const name = async (raw: string) =>
    ((await (await upload(base, a, 'all', raw, 'x')).json()) as ChatMessage).file?.name;
  assert.equal(await name('../../etc/passwd'), 'passwd');
  assert.equal(await name('..\\..\\evil.bat'), 'evil.bat');
  assert.equal(await name('a‮txt.exe'), 'atxt.exe');
  assert.equal(await name(''), '未命名文件');
  await app.close();
});

test('私聊文件只有双方能下载，第三人和未登录都不行', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = (await session(base, b)).me.id;

  const res = await upload(base, a, bId, 'secret.txt', 'secret');
  const { file } = (await res.json()) as ChatMessage;
  const get = (cookie?: string) =>
    fetch(`${base}/api/files/${file?.id}`, { headers: cookie ? { Cookie: cookie } : {} });

  assert.equal((await get(a)).status, 200);
  assert.equal((await get(b)).status, 200);
  assert.equal((await get(c)).status, 404);
  assert.equal((await get()).status, 401);
  await app.close();
});

test('正好 20MB 可以上传，超过 1 字节被拒绝且不写入磁盘', async () => {
  const { app, base, port, dataDir } = await start();
  const a = await login(base, 'A');

  const exact = await upload(base, a, 'all', 'exact.bin', Buffer.alloc(20 * MB, 7));
  assert.equal(exact.status, 200);
  const { file } = (await exact.json()) as ChatMessage;
  const body = await (await fetch(`${base}/api/files/${file?.id}`, { headers: { Cookie: a } })).arrayBuffer();
  assert.equal(body.byteLength, 20 * MB);

  // 用底层请求声明超限的大小，不发送内容，服务器应该直接拒绝
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/api/files?to=all&name=big.bin',
      headers: { Cookie: a, 'Content-Length': 20 * MB + 1 },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(status, 413);
  assert.equal(readdirSync(join(dataDir, 'files')).length, 1);
  await app.close();
});

test('上传中途断开：不产生消息，临时文件被清掉，预占容量被释放', async () => {
  const { app, base, port, dataDir } = await start({ maxStorageBytes: 2 * MB });
  const a = await login(base, 'A');

  await new Promise<void>((resolve) => {
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/api/files?to=all&name=part.bin',
      headers: { Cookie: a, 'Content-Length': MB },
    });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(1024), () => setTimeout(() => req.destroy(), 50));
    req.on('close', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(readdirSync(join(dataDir, 'files')), []);
  assert.equal((await session(base, a)).messages.length, 0);
  // 容量如果没释放，这里的 1.5MB 就放不下了
  const res = await upload(base, a, 'all', 'after.bin', Buffer.alloc(1.5 * MB));
  assert.equal(res.status, 200);
  await app.close();
});

test('总容量满了拒绝上传', async () => {
  const { app, base } = await start({ maxStorageBytes: MB });
  const a = await login(base, 'A');
  assert.equal((await upload(base, a, 'all', 'one.bin', Buffer.alloc(MB))).status, 200);
  assert.equal((await upload(base, a, 'all', 'two.bin', 'x')).status, 507);
  await app.close();
});

test('文件到期后不能下载，清理后磁盘文件被删除，消息保留', async () => {
  const { app, base, dataDir } = await start({ fileTtlMs: 30 });
  const a = await login(base, 'A');
  const { file } = (await (await upload(base, a, 'all', 'old.txt', 'old')).json()) as ChatMessage;
  const path = join(dataDir, 'files', file?.id ?? '');
  assert.ok(existsSync(path));

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await fetch(`${base}/api/files/${file?.id}`, { headers: { Cookie: a } })).status, 410);

  app.store.sweep();
  assert.ok(!existsSync(path));
  assert.equal((await session(base, a)).messages.length, 1);
  await app.close();
});

test('来自其他网站的 POST 请求被拒绝', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const post = (origin: string) =>
    fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a, Origin: origin },
      body: JSON.stringify({ to: 'all', text: 'x' }),
    });
  assert.equal((await post('http://evil.example')).status, 403);
  assert.equal((await post('null')).status, 403);
  assert.equal((await post(base)).status, 200);
  await app.close();
});

test('不能通过路径穿越读取项目文件', async () => {
  const { app, port } = await start();
  const statusOf = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ port, host: '127.0.0.1', path }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await statusOf('/../package.json'), 404);
  assert.equal(await statusOf('/..%2f..%2fpackage.json'), 404);
  assert.equal(await statusOf('/package.json'), 404);
  assert.equal(await statusOf('/data/users.json'), 404);
  await app.close();
});

test('SSE 推送：在线状态和私聊只发给相关的人', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = (await session(base, b)).me.id;

  const streamB = await subscribe(base, b);
  const streamC = await subscribe(base, c);
  const online = async (cookie: string, id: string) =>
    (await session(base, cookie)).users.find((user) => user.id === id)?.online;
  assert.equal(await online(a, bId), true);

  await postJson(base, '/api/messages', { to: bId, text: '只给B' }, a);
  await postJson(base, '/api/messages', { to: 'all', text: '给全组' }, a);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(streamB.read().includes('只给B'));
  assert.ok(streamB.read().includes('给全组'));
  assert.ok(!streamC.read().includes('只给B'), '第三人不应收到私聊推送');
  assert.ok(streamC.read().includes('给全组'));

  // 断开后变为离线，这也验证了不会在请求读完时就被误判离线
  streamB.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await online(a, bId), false);

  streamC.close();
  await app.close();
});

test('重启后登录状态、消息和文件都还在', async () => {
  const first = await start();
  const a = await login(first.base, 'A');
  await postJson(first.base, '/api/messages', { to: 'all', text: '重启前' }, a);
  const { file } = (await (await upload(first.base, a, 'all', 'keep.txt', 'keep')).json()) as ChatMessage;
  await first.app.close();

  const second = await start({ dataDir: first.dataDir });
  const restored = await session(second.base, a);
  assert.equal(restored.me.name, 'A');
  assert.equal(restored.messages.length, 2);
  const res = await fetch(`${second.base}/api/files/${file?.id}`, { headers: { Cookie: a } });
  assert.equal(await res.text(), 'keep');
  await second.app.close();
});

test('退出后令牌立即失效，磁盘上不保存令牌原文', async () => {
  const { app, base, dataDir } = await start();
  const a = await login(base, 'A');
  const token = a.split('=')[1];
  assert.ok(!readFileSync(join(dataDir, 'users.json'), 'utf8').includes(token));

  assert.equal((await postJson(base, '/api/logout', {}, a)).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: a } })).status, 401);
  await app.close();
});

test('页面静态文件能访问，并带有安全响应头', async () => {
  const { app, base } = await start();
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /内网快传/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  await app.close();
});
