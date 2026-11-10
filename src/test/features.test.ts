// 新功能的集成测试：HTTPS、头像、个人资料、表情、图片预览、特效、投票、接龙、大转盘、五子棋。
// 重点验证服务器端的校验，浏览器发来的任何数据都不能被直接信任。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { createCertificate } from '../server/tls.js';
import type { ChatMessage, CustomSticker, UserInfo } from '../shared/types.js';
import {
  act,
  CODE,
  gifHeader,
  jpegHeader,
  login,
  myId,
  pngHeader,
  postBinary,
  postJson,
  send,
  session,
  start,
  subscribe,
  testConfig,
  upload,
  wait,
} from './helpers.js';

/** 只声明大小、不发送内容的上传请求，用来测试超限时服务器直接拒绝 */
function declareOnly(port: number, path: string, cookie: string, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, host: '127.0.0.1', method: 'POST', path, headers: { Cookie: cookie, 'Content-Length': length } });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.flushHeaders();
  });
}

// ---------- HTTPS ----------

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  secure: boolean,
  options: { port: number; method?: string; path: string; headers?: Record<string, string | number>; ca?: string; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const send = secure ? httpsRequest : httpRequest;
    const req = send({ host: '127.0.0.1', ...options }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('HTTPS：证书能通过校验，Cookie 带 Secure；同一端口的 http:// 也能用，两边的登录状态互不通用', async () => {
  const { key, cert } = createCertificate(['127.0.0.1'], ['localhost']);
  const app = createApp(testConfig({ https: true }), { tls: { key, cert } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;

  // 把这张证书当作唯一信任的证书：能连上，说明证书格式、签名和 IP 地址都对
  const body = JSON.stringify({ name: '张三', code: CODE });
  const loginRes = await rawRequest(true, {
    port,
    method: 'POST',
    path: '/api/login',
    ca: cert,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(loginRes.status, 200);
  const setCookie = String(loginRes.headers['set-cookie']);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /HttpOnly/);
  // 不能发 HSTS，否则自签名证书的“继续访问”会被浏览器禁用
  assert.equal(loginRes.headers['strict-transport-security'], undefined);

  const cookie = setCookie.split(';')[0];
  const sessionRes = await rawRequest(true, { port, path: '/api/session', ca: cert, headers: { Cookie: cookie } });
  assert.equal(sessionRes.status, 200);

  // http:// 能打开页面，但 https 的登录状态在 http 上不算数（Cookie 名字不同，浏览器也不会发 Secure Cookie）
  const page = await rawRequest(false, { port, path: '/' });
  assert.equal(page.status, 200);
  const plainSession = await rawRequest(false, { port, path: '/api/session', headers: { Cookie: cookie } });
  assert.equal(plainSession.status, 401);

  // http 上单独登录，Cookie 不带 Secure
  const plainLogin = await rawRequest(false, {
    port,
    method: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` },
    body,
  });
  assert.equal(plainLogin.status, 200);
  assert.doesNotMatch(String(plainLogin.headers['set-cookie']), /Secure/);

  // http 页面不能冒充 https 页面发请求：Origin 的协议对不上就拒绝
  const crossScheme = await rawRequest(true, {
    port,
    method: 'POST',
    path: '/api/logout',
    ca: cert,
    headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': 2 },
    body: '{}',
  });
  assert.equal(crossScheme.status, 403);

  // 不信任这张证书的客户端会拒绝连接，证明连接确实是 TLS 加密的
  await assert.rejects(rawRequest(true, { port, path: '/' }), /self.signed|unable to verify/i);
  await app.close();
});

test('HTTPS：设置了只允许 HTTPS 时，http:// 会跳转到 https://', async () => {
  const { key, cert } = createCertificate(['127.0.0.1'], ['localhost']);
  const app = createApp(testConfig({ https: true, allowHttp: false }), { tls: { key, cert } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  const redirect = await rawRequest(false, { port, path: '/api/session?x=1', headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.location, `https://127.0.0.1:${port}/api/session?x=1`);
  await app.close();
});

// ---------- 头像和个人资料 ----------

test('头像：只接受真正的图片，换头像后版本号增加，可以移除', async () => {
  const { app, base, port } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const aId = await myId(base, a);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await postBinary(base, '/api/me/avatar', a, svg)).status, 415);
  assert.equal((await postBinary(base, '/api/me/avatar', a, Buffer.from('<html><script>alert(1)</script>'))).status, 415);
  // 文件头说自己是 3 万 × 3 万的图片：解码会耗尽内存，拒绝
  assert.equal((await postBinary(base, '/api/me/avatar', a, pngHeader(30000, 30000))).status, 415);
  assert.equal(await declareOnly(port, '/api/me/avatar', a, 600 * 1024), 413);

  const first = (await (await postBinary(base, '/api/me/avatar', a, pngHeader(256, 256))).json()) as UserInfo;
  assert.equal(first.avatar, 1);
  assert.equal((await session(base, b)).users.find((user) => user.id === aId)?.avatar, 1);

  const image = await fetch(`${base}/api/avatars/${aId}`, { headers: { Cookie: b } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/api/avatars/${aId}`)).status, 401);

  const second = (await (await postBinary(base, '/api/me/avatar', a, jpegHeader(300, 200))).json()) as UserInfo;
  assert.equal(second.avatar, 2);
  assert.equal((await fetch(`${base}/api/avatars/${aId}`, { headers: { Cookie: b } })).headers.get('content-type'), 'image/jpeg');

  const removed = (await (await postJson(base, '/api/me/avatar/delete', {}, a)).json()) as UserInfo;
  assert.equal(removed.avatar, null);
  assert.equal((await fetch(`${base}/api/avatars/${aId}`, { headers: { Cookie: b } })).status, 404);
  await app.close();
});

test('个人资料：签名限长，名片背景和气泡只能从内置列表里选', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');

  const updated = await postJson(base, '/api/me', { bio: '摸鱼达人', nameplate: 'galaxy', bubble: 'neon' }, a);
  assert.equal(updated.status, 200);
  const me = (await updated.json()) as UserInfo;
  assert.deepEqual([me.bio, me.nameplate, me.bubble], ['摸鱼达人', 'galaxy', 'neon']);
  const seenByB = (await session(base, b)).users.find((user) => user.id === me.id);
  assert.equal(seenByB?.nameplate, 'galaxy');

  // 这些值会变成页面上的类名，必须是已知的 id
  assert.equal((await postJson(base, '/api/me', { nameplate: 'x" onclick="alert(1)' }, a)).status, 400);
  assert.equal((await postJson(base, '/api/me', { bubble: 'nope' }, a)).status, 400);
  assert.equal((await postJson(base, '/api/me', { bio: '字'.repeat(41) }, a)).status, 400);
  assert.equal((await postJson(base, '/api/me', { name: 'B' }, a)).status, 200, '对方不在线时可以同名');
  await app.close();
});

// ---------- 表情和特效 ----------

test('自定义表情：全组共享，只接受图片，只有添加的人能删', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');

  assert.equal((await postBinary(base, '/api/stickers?name=x', a, Buffer.from('<svg/>'))).status, 415);
  const res = await postBinary(base, `/api/stickers?name=${encodeURIComponent('猫猫哈气')}`, a, gifHeader(200, 200));
  assert.equal(res.status, 200);
  const sticker = (await res.json()) as CustomSticker;
  assert.equal(sticker.name, '猫猫哈气');
  assert.deepEqual((await session(base, b)).stickers.map((item) => item.id), [sticker.id]);

  const image = await fetch(`${base}/api/stickers/${sticker.id}`, { headers: { Cookie: b } });
  assert.equal(image.headers.get('content-type'), 'image/gif');
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);

  // 用表情发消息：内置和自定义都要真实存在
  await send(base, b, { to: 'all', sticker: { source: 'custom', id: sticker.id } });
  await send(base, b, { to: 'all', sticker: { source: 'builtin', id: 'pig-heng' } });
  assert.equal((await postJson(base, '/api/messages', { to: 'all', sticker: { source: 'builtin', id: 'nope' } }, b)).status, 400);
  assert.equal((await postJson(base, '/api/messages', { to: 'all', sticker: { source: 'custom', id: 'nope' } }, b)).status, 400);

  assert.equal((await postJson(base, `/api/stickers/${sticker.id}/delete`, {}, b)).status, 403);
  assert.equal((await postJson(base, `/api/stickers/${sticker.id}/delete`, {}, a)).status, 200);
  assert.equal((await fetch(`${base}/api/stickers/${sticker.id}`, { headers: { Cookie: b } })).status, 404);
  assert.deepEqual((await session(base, b)).stickers, []);
  await app.close();
});

test('文字特效只能用内置的；一条消息只能有一种内容', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const message = await send(base, a, { to: 'all', text: '生日快乐', effect: 'confetti' });
  assert.equal(message.effect, 'confetti');
  assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', effect: 'evil' }, a)).status, 400);
  assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', poll: {} }, a)).status, 400);
  assert.equal((await postJson(base, '/api/messages', { to: 'all' }, a)).status, 400);
  await app.close();
});

// ---------- 图片预览 ----------

test('图片可以预览，其他文件不行；预览同样受私聊权限保护', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = await myId(base, b);

  const photo = (await (await upload(base, a, bId, '照片.jpg', jpegHeader(4000, 3000))).json()) as ChatMessage;
  assert.equal(photo.file?.image, 'jpeg');
  const preview = await fetch(`${base}/api/files/${photo.file?.id}/preview`, { headers: { Cookie: b } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/jpeg');
  assert.match(preview.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(preview.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal((await fetch(`${base}/api/files/${photo.file?.id}/preview`, { headers: { Cookie: c } })).status, 404);

  // 扩展名是 .png，内容是网页：不当图片，不能预览
  const fake = (await (await upload(base, a, 'all', 'fake.png', '<html><script>alert(1)</script></html>')).json()) as ChatMessage;
  assert.equal(fake.file?.image, undefined);
  assert.equal((await fetch(`${base}/api/files/${fake.file?.id}/preview`, { headers: { Cookie: b } })).status, 404);

  const huge = (await (await upload(base, a, 'all', 'huge.png', pngHeader(30000, 30000))).json()) as ChatMessage;
  assert.equal(huge.file?.image, undefined, '尺寸过大的图片不预览');
  await app.close();
});

// ---------- 投票 ----------

test('投票：单选、多选、撤回，只有发起人能结束，结束后不能再投', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const [bId, cId] = [await myId(base, b), await myId(base, c)];

  const poll = await send(base, a, { to: 'all', poll: { question: '去哪吃', options: ['火锅', '烧烤', '粉'], multi: false } });
  const vote = async (cookie: string, choices: unknown) => act(base, cookie, poll.id, { type: 'vote', choices });

  let res = await vote(b, [1]);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as ChatMessage).poll?.votes[bId], [1]);
  assert.equal((await vote(b, [0, 1])).status, 400, '单选不能选两个');
  assert.equal((await vote(b, [5])).status, 400);
  assert.equal((await vote(b, ['0'])).status, 400);
  res = await vote(b, []);
  assert.equal(((await res.json()) as ChatMessage).poll?.votes[bId], undefined, '空数组表示撤回');
  assert.equal((await vote(c, [2])).status, 200);

  assert.equal((await act(base, b, poll.id, { type: 'close' })).status, 403);
  assert.equal((await act(base, a, poll.id, { type: 'close' })).status, 200);
  assert.equal((await vote(b, [0])).status, 409);
  const saved = (await session(base, a)).messages.find((m) => m.id === poll.id);
  assert.deepEqual(saved?.poll?.votes, { [cId]: [2] });

  const multi = await send(base, a, { to: 'all', poll: { question: '周末活动', options: ['爬山', '电影', '剧本杀'], multi: true } });
  const multiRes = await act(base, b, multi.id, { type: 'vote', choices: [2, 0, 2] });
  assert.deepEqual(((await multiRes.json()) as ChatMessage).poll?.votes[bId], [0, 2], '去重并排序');

  const bad = (poll: unknown) => postJson(base, '/api/messages', { to: 'all', poll }, a);
  assert.equal((await bad({ question: 'q', options: ['只有一个'] })).status, 400);
  assert.equal((await bad({ question: 'q', options: ['重复', '重复'] })).status, 400);
  assert.equal((await bad({ question: 'q', options: Array.from({ length: 11 }, (_, i) => `选项${i}`) })).status, 400);
  assert.equal((await bad({ question: '', options: ['a', 'b'] })).status, 400);
  await app.close();
});

test('私聊里的投票和棋局，第三人看不到也操作不了', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = await myId(base, b);

  const poll = await send(base, a, { to: bId, poll: { question: '私下问问', options: ['好', '不好'], multi: false } });
  const game = await send(base, a, { to: bId, gomoku: {} });
  assert.equal((await act(base, c, poll.id, { type: 'vote', choices: [0] })).status, 404);
  assert.equal((await act(base, c, game.id, { type: 'join' })).status, 404);
  assert.ok(!(await session(base, c)).messages.some((m) => m.id === poll.id));
  assert.equal((await act(base, b, poll.id, { type: 'vote', choices: [0] })).status, 200);
  await app.close();
});

test('投票等状态变化会实时推送，私聊的不会推给第三人', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = await myId(base, b);
  const streamB = await subscribe(base, b);
  const streamC = await subscribe(base, c);

  const poll = await send(base, a, { to: bId, poll: { question: '只问B', options: ['甲', '乙'], multi: false } });
  await act(base, a, poll.id, { type: 'vote', choices: [1] });
  await wait(100);
  assert.ok(streamB.read().includes('"votes":{"'), 'B 收到了投票更新');
  assert.ok(!streamC.read().includes('只问B'), 'C 不应收到私聊里的投票');
  streamB.close();
  streamC.close();
  await app.close();
});

// ---------- 接龙 ----------

test('接龙：每人一条，可以修改和撤回，发起人可以结束', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');

  const relay = await send(base, a, { to: 'all', relay: { title: '明天午饭', first: 'A 1份' } });
  assert.equal(relay.relay?.entries.length, 1);
  const join = async (cookie: string, text: string) =>
    (await (await act(base, cookie, relay.id, { type: 'join', text })).json()) as ChatMessage;

  assert.equal((await join(b, 'B 2份')).relay?.entries.length, 2);
  const changed = await join(b, 'B 3份');
  assert.deepEqual(changed.relay?.entries.map((entry) => entry.text), ['A 1份', 'B 3份'], '修改不会新增一条');
  assert.equal((await act(base, b, relay.id, { type: 'join', text: '   ' })).status, 400);
  const left = (await (await act(base, b, relay.id, { type: 'leave' })).json()) as ChatMessage;
  assert.equal(left.relay?.entries.length, 1);

  assert.equal((await act(base, b, relay.id, { type: 'close' })).status, 403);
  assert.equal((await act(base, a, relay.id, { type: 'close' })).status, 200);
  assert.equal((await act(base, b, relay.id, { type: 'join', text: '晚了' })).status, 409);
  await app.close();
});

// ---------- 大转盘 ----------

test('大转盘：结果由服务器抽取，浏览器传来的结果会被忽略', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  for (let i = 0; i < 10; i += 1) {
    const wheel = await send(base, a, { to: 'all', wheel: { title: '谁拿外卖', options: ['甲', '乙', '丙'], result: 99 } });
    assert.ok(wheel.wheel && wheel.wheel.result >= 0 && wheel.wheel.result < 3);
  }
  const bad = (wheel: unknown) => postJson(base, '/api/messages', { to: 'all', wheel }, a);
  assert.equal((await bad({ title: 't', options: ['只有一个'] })).status, 400);
  assert.equal((await bad({ title: 't', options: ['这个选项名字实在是太长了超过了二十个字的限制呀'] })).status, 400);
  // 对转盘不能做任何操作
  const wheel = await send(base, a, { to: 'all', wheel: { title: 't', options: ['a', 'b'] } });
  assert.equal((await act(base, a, wheel.id, { type: 'close' })).status, 400);
  await app.close();
});

// ---------- 五子棋 ----------

test('五子棋：要等人应战，只能轮到自己时下，不能下在有子的地方，连五获胜', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const game = await send(base, a, { to: 'all', gomoku: {} });
  const move = (cookie: string, cell: unknown) => act(base, cookie, game.id, { type: 'move', cell });

  assert.equal((await move(a, 0)).status, 409, '还没人应战');
  assert.equal((await act(base, a, game.id, { type: 'join' })).status, 409, '不能和自己下');
  assert.equal((await act(base, b, game.id, { type: 'join' })).status, 200);
  assert.equal((await act(base, c, game.id, { type: 'join' })).status, 409, '已经有人应战');

  assert.equal((await move(b, 20)).status, 409, '黑棋先手');
  assert.equal((await move(a, 0)).status, 200);
  assert.equal((await move(a, 1)).status, 409, '不能连下两手');
  assert.equal((await move(b, 0)).status, 409, '这里已经有子');
  assert.equal((await move(b, 225)).status, 400);
  assert.equal((await move(b, 1.5)).status, 400);
  assert.equal((await move(c, 30)).status, 409, '旁观者不能下');

  // 黑棋在第一行连下五个，白棋在第二行陪下
  let last: ChatMessage | undefined;
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await move(b, 15 + i)).status, 200);
    last = (await (await move(a, 1 + i)).json()) as ChatMessage;
  }
  assert.equal(last?.gomoku?.finished, true);
  assert.equal(last?.gomoku?.winner, 'black');
  assert.equal((await move(b, 30)).status, 409, '对局结束后不能再下');
  await app.close();
});

test('五子棋：私聊里只有对方能应战；认输算对方赢，没人应战时认输等于取消', async () => {
  const { app, base } = await start();
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const bId = await myId(base, b);

  const waiting = await send(base, a, { to: bId, gomoku: {} });
  const canceled = (await (await act(base, a, waiting.id, { type: 'resign' })).json()) as ChatMessage;
  assert.deepEqual([canceled.gomoku?.finished, canceled.gomoku?.winner], [true, null]);

  const game = await send(base, a, { to: bId, gomoku: {} });
  assert.equal((await act(base, b, game.id, { type: 'join' })).status, 200);
  const resigned = (await (await act(base, a, game.id, { type: 'resign' })).json()) as ChatMessage;
  assert.deepEqual([resigned.gomoku?.winner, resigned.gomoku?.resignedBy], ['white', resigned.from]);
  await app.close();
});

// ---------- 撤回 ----------

test('撤回：只能撤回自己的，不限时间，服务器上的内容和文件永久删除', async () => {
  const first = await start();
  const { base, dataDir } = first;
  const a = await login(base, 'A');
  const b = await login(base, 'B');
  const c = await login(base, 'C');
  const bId = await myId(base, b);
  const streamB = await subscribe(base, b);

  const text = await send(base, a, { to: 'all', text: 'secret-text-to-recall' });
  const file = (await (await upload(base, a, bId, '机密.txt', 'secret-file-content')).json()) as ChatMessage;
  const poll = await send(base, a, { to: 'all', poll: { question: '撤回的投票', options: ['甲', '乙'], multi: false } });
  const recall = (cookie: string, id: string) => postJson(base, `/api/messages/${id}/recall`, {}, cookie);

  assert.equal((await recall(b, text.id)).status, 403, '不能撤回别人的消息');
  assert.equal((await recall(c, file.id)).status, 404, '第三人看不到私聊，也就撤不了');

  // 把消息改成 6 天前发的：撤回没有时间限制
  const stored = first.app.store.findMessage(text.id);
  assert.ok(stored);
  stored.at = Date.now() - 6 * 24 * 60 * 60 * 1000;

  assert.equal((await recall(a, text.id)).status, 200);
  assert.equal((await recall(a, file.id)).status, 200);
  assert.equal((await recall(a, poll.id)).status, 200);
  assert.equal((await recall(a, text.id)).status, 404, '已经删掉了');
  await wait(100);

  // 实时通知对方删除
  assert.ok(streamB.read().includes(`{"type":"deleted","id":"${text.id}"}`));
  assert.ok(streamB.read().includes(`{"type":"deleted","id":"${file.id}"}`));
  streamB.close();

  // 消息、文件、对它的操作都没了
  assert.deepEqual((await session(base, b)).messages, []);
  assert.equal((await fetch(`${base}/api/files/${file.file?.id}`, { headers: { Cookie: b } })).status, 404);
  assert.equal((await act(base, b, poll.id, { type: 'vote', choices: [0] })).status, 404);
  assert.deepEqual(readdirSync(join(dataDir, 'files')), []);
  const onDisk = readFileSync(join(dataDir, 'messages.jsonl'), 'utf8');
  assert.ok(!onDisk.includes('secret-text-to-recall'), '磁盘上的记录里也删掉了');
  assert.ok(!onDisk.includes('撤回的投票'));
  await first.app.close();

  // 重启后也不会回来
  const second = await start({ dataDir });
  assert.deepEqual((await session(second.base, a)).messages, []);
  await second.app.close();
});
