// 各个路由文件共用的服务和类型
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { ChatMessage, UserInfo } from '../shared/types.js';
import type { Config } from './config.js';
import type { EventHub } from './events.js';
import { clientIp } from './http.js';
import type { Store, StoredUser } from './store.js';

export interface AppContext {
  config: Config;
  store: Store;
  hub: EventHub;
  /** 服务器有没有开 HTTPS。http 页面据此提示“可以改用加密地址” */
  httpsAvailable: boolean;
  /** 取当前登录的同事，没登录就抛出 401 */
  requireUser(req: IncomingMessage): StoredUser;
  /** 存储空间满了就抛出 507。发消息、传文件、加表情之前调用 */
  requireStorage(): void;
  toUserInfo(user: StoredUser): UserInfo;
  /** 把新消息或更新后的消息推送给能看到它的人 */
  publish(message: ChatMessage): void;
  /** 通知能看到这条消息的人：它被撤回了 */
  publishDeleted(message: ChatMessage): void;
  broadcastUsers(): void;
  broadcastStickers(): void;
}

export interface RouteParams {
  url: URL;
  /** 路径正则里括号匹配到的部分，比如消息 id */
  match: string[];
}

export interface Route {
  method: 'GET' | 'POST';
  /** 字符串表示精确匹配，正则表示带参数的路径 */
  path: string | RegExp;
  handler(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> | void;
}

/** 路径里的 id 都是 randomUUID 生成的，格式固定 */
export const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/** 这个请求是不是通过 HTTPS 来的。同一个端口上 HTTPS 和 HTTP 都能访问，要按请求判断 */
export function isSecure(req: IncomingMessage): boolean {
  return (req.socket as TLSSocket).encrypted === true;
}

/**
 * 是不是在服务器电脑上用 localhost 打开的。这样打开的人可以清理任何人的文件：
 * 能操作服务器电脑的人本来就能直接看到 data 目录里的所有数据，给他这个权限不会多暴露什么。
 * 如果在前面加了反向代理（所有请求都像是从本机来的），要用 LAN_DROP_LOCAL_ADMIN=0 关掉。
 */
export function isAdmin(req: IncomingMessage, config: Config): boolean {
  if (!config.localAdmin) return false;
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}
