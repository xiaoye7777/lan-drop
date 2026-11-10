// 前后端共用的数据结构。
// 这个文件只放类型：前端用 import type 引入，编译后不会产生运行时依赖。

/** 表示发给全组的特殊接收方。前后端各定义一个这个类型的常量，保证取值一致 */
export type GroupRecipient = 'all';

/** 消息接收方：全组，或某位同事的用户 id */
export type Recipient = GroupRecipient | (string & {});

/** 允许上传和预览的图片格式。SVG 可以内嵌脚本，所以不在其中 */
export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

export interface UserInfo {
  id: string;
  name: string;
  /** 同事的内网 IP，昵称重复时用来区分 */
  ip: string;
  online: boolean;
  /** 头像版本号，每次换头像加 1；没有头像时为 null */
  avatar: number | null;
  /** 个性签名 */
  bio: string;
  /** 名片背景 id，见 catalog.ts 的 NAMEPLATES */
  nameplate: string;
  /** 聊天气泡样式 id，见 catalog.ts 的 BUBBLES */
  bubble: string;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  /** 文件到期时间（毫秒时间戳），到期后服务器会删除文件 */
  expiresAt: number;
  /** 文件是可以预览的图片时才有这个字段 */
  image?: ImageType;
}

/** 表情：内置表情用 catalog.ts 里的 id，自定义表情用上传后的 id */
export interface StickerRef {
  source: 'builtin' | 'custom';
  id: string;
}

/** 全组共享的自定义表情 */
export interface CustomSticker {
  id: string;
  name: string;
  /** 上传者的用户 id，只有上传者可以删除 */
  owner: string;
  type: ImageType;
  size: number;
}

/** 实名投票：votes 记录每个人选了哪几项 */
export interface Poll {
  question: string;
  options: string[];
  multi: boolean;
  votes: Record<string, number[]>;
  closed: boolean;
}

/** 接龙：每人一条，可以修改或撤回自己的那条 */
export interface Relay {
  title: string;
  entries: { userId: string; name: string; text: string }[];
  closed: boolean;
}

/** 大转盘：结果在服务器上抽好，所有人看到的都一样 */
export interface Wheel {
  title: string;
  options: string[];
  result: number;
}

/** 五子棋：棋盘 15×15，格子编号 = 行 × 15 + 列；moves 按落子顺序记录，黑棋先手 */
export interface Gomoku {
  black: string;
  blackName: string;
  /** 还没人应战时为 null */
  white: string | null;
  whiteName: string | null;
  moves: number[];
  finished: boolean;
  /** 对局结束后的结果；取消对局时为 null */
  winner: 'black' | 'white' | 'draw' | null;
  /** 认输或取消的人 */
  resignedBy?: string;
}

/**
 * 一条消息。除了基本信息，下面的内容字段只会出现一种：
 * text、file、sticker、poll、relay、wheel、gomoku。
 */
export interface ChatMessage {
  id: string;
  from: string;
  /** 发送时的昵称快照，对方改名或被清理后历史消息也能正常显示 */
  fromName: string;
  to: Recipient;
  at: number;
  text?: string;
  /** 文字消息的特效 id，见 catalog.ts 的 EFFECTS */
  effect?: string;
  file?: FileMeta;
  sticker?: StickerRef;
  poll?: Poll;
  relay?: Relay;
  wheel?: Wheel;
  gomoku?: Gomoku;
}

export interface Limits {
  maxFileBytes: number;
  maxStickerBytes: number;
  maxAvatarBytes: number;
}

/** GET /api/session 的返回值：前端渲染页面需要的全部初始数据 */
export interface SessionInfo {
  me: UserInfo;
  users: UserInfo[];
  messages: ChatMessage[];
  stickers: CustomSticker[];
  limits: Limits;
}

/** 通过 SSE 推送给浏览器的事件。message 既表示新消息，也表示投票等消息的状态更新 */
export type ServerEvent =
  | { type: 'users'; users: UserInfo[] }
  | { type: 'message'; message: ChatMessage }
  /** 消息被发送者撤回，服务器上已经删除 */
  | { type: 'deleted'; id: string }
  | { type: 'stickers'; stickers: CustomSticker[] };
