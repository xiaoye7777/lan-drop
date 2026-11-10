// 各个路由文件共用的服务和类型
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatMessage, UserInfo } from '../shared/types.js';
import type { Config } from './config.js';
import type { EventHub } from './events.js';
import type { Store, StoredUser } from './store.js';

export interface AppContext {
  config: Config;
  store: Store;
  hub: EventHub;
  /** 走 HTTPS 时 Cookie 要加 Secure 标记 */
  secure: boolean;
  /** 取当前登录的同事，没登录就抛出 401 */
  requireUser(req: IncomingMessage): StoredUser;
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
