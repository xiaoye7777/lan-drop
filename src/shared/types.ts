// 前后端共用的数据结构。
// 这个文件只放类型：前端用 import type 引入，编译后不会产生运行时依赖。

/** 表示发给全组的特殊接收方。前后端各定义一个这个类型的常量，保证取值一致 */
export type GroupRecipient = 'all';

/** 消息接收方：全组，或某位同事的用户 id */
export type Recipient = GroupRecipient | (string & {});

export interface UserInfo {
  id: string;
  name: string;
  /** 同事的内网 IP，昵称重复时用来区分 */
  ip: string;
  online: boolean;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  /** 文件到期时间（毫秒时间戳），到期后服务器会删除文件 */
  expiresAt: number;
}

export interface ChatMessage {
  id: string;
  from: string;
  /** 发送时的昵称快照，对方改名或被清理后历史消息也能正常显示 */
  fromName: string;
  to: Recipient;
  at: number;
  /** text 和 file 二选一 */
  text?: string;
  file?: FileMeta;
}

/** GET /api/session 的返回值：前端渲染页面需要的全部初始数据 */
export interface SessionInfo {
  me: UserInfo;
  users: UserInfo[];
  messages: ChatMessage[];
  maxFileBytes: number;
}

/** 通过 SSE 推送给浏览器的事件 */
export type ServerEvent =
  | { type: 'users'; users: UserInfo[] }
  | { type: 'message'; message: ChatMessage };
