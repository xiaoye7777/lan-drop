// 测试共用的工具：启动临时服务器、登录、发请求，以及生成各种格式的图片文件头
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { createApp } from '../server/app.js';
import type { App } from '../server/app.js';
import type { Config } from '../server/config.js';
import type { ChatMessage, SessionInfo } from '../shared/types.js';

export const CODE = 'test-access-code';
export const MB = 1024 * 1024;
const dataDirs: string[] = [];

after(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

export function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lan-drop-test-'));
  dataDirs.push(dir);
  return dir;
}

export interface Running {
  app: App;
  base: string;
  port: number;
  dataDir: string;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    https: false,
    dataDir: overrides.dataDir ?? newDataDir(),
    accessCode: CODE,
    maxFileBytes: 20 * MB,
    maxStorageBytes: 100 * MB,
    fileTtlMs: 60 * 60 * 1000,
    messageTtlMs: 7 * 24 * 60 * 60 * 1000,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

/** 启动一个只监听本机、数据放在临时目录的服务器 */
export async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const config = testConfig(overrides);
  const app = createApp(config);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, port, dataDir: config.dataDir };
}

export function postJson(base: string, path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

export async function login(base: string, name: string): Promise<string> {
  const res = await postJson(base, '/api/login', { name, code: CODE });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

export async function session(base: string, cookie: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as SessionInfo;
}

export async function myId(base: string, cookie: string): Promise<string> {
  return (await session(base, cookie)).me.id;
}

export async function upload(
  base: string,
  cookie: string,
  to: string,
  name: string,
  content: Buffer | string,
): Promise<Response> {
  const query = new URLSearchParams({ to, name });
  return fetch(`${base}/api/files?${query}`, { method: 'POST', headers: { Cookie: cookie }, body: content });
}

export async function postBinary(base: string, path: string, cookie: string, content: Buffer): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { Cookie: cookie }, body: content });
}

/** 发消息并返回服务器返回的消息，状态码不是 200 时直接让测试失败 */
export async function send(base: string, cookie: string, body: Record<string, unknown>): Promise<ChatMessage> {
  const res = await postJson(base, '/api/messages', body, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as ChatMessage;
}

export function act(base: string, cookie: string, messageId: string, action: Record<string, unknown>): Promise<Response> {
  return postJson(base, `/api/messages/${messageId}/actions`, action, cookie);
}

/** 打开事件流，持续收集收到的内容 */
export async function subscribe(base: string, cookie: string) {
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

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 图片文件头：服务器只看开头的字节识别格式和尺寸 ----------

export function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

export function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** 前面放一个 APP1（EXIF）段，验证识别时能跳过它找到尺寸 */
export function jpegHeader(width: number, height: number): Buffer {
  const app1 = Buffer.alloc(4 + 200);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(202, 2);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]);
}

export function webpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}
