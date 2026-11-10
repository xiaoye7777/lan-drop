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
  /** 被拍一拍时接在后面的话，比如“的小脑袋” */
  nudgeSuffix: string;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  /** 上传者的用户 id。文件被转发后仍然属于上传者，只有上传者能清理它 */
  owner: string;
  /** 文件是可以预览的图片时才有这个字段 */
  image?: ImageType;
  /** 文件已经被清理（为了腾出空间），消息还在，但不能再下载 */
  removed?: boolean;
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

/** 引用回复时，被引用消息的快照。原消息撤回后 summary 会被清空，recalled 变为 true */
export interface ReplyRef {
  id: string;
  from: string;
  fromName: string;
  summary: string;
  recalled?: boolean;
}

/** 合并转发里的一条消息。投票、五子棋这类互动内容只保留一句说明（summary） */
export interface ForwardItem {
  from: string;
  fromName: string;
  at: number;
  text?: string;
  sticker?: StickerRef;
  file?: FileMeta;
  summary?: string;
}

/** 合并转发的聊天记录 */
export interface ForwardBundle {
  /** 比如“全组的聊天记录”“张三和李四的聊天记录” */
  title: string;
  items: ForwardItem[];
}

/** 拍一拍：target 是被拍的人，suffix 是被拍的人自己设置的后缀 */
export interface Nudge {
  target: string;
  targetName: string;
  suffix: string;
}

/**
 * 一条消息。除了基本信息，下面的内容字段只会出现一种：
 * text、file、sticker、poll、relay、wheel、gomoku、forward、nudge。
 * reply 和 mentions 只会和 text 一起出现。
 */
export interface ChatMessage {
  id: string;
  from: string;
  /** 发送时的昵称快照，对方改名后历史消息也能正常显示 */
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
  forward?: ForwardBundle;
  nudge?: Nudge;
  reply?: ReplyRef;
  /** 被 @ 的同事 id；@所有人 时包含 catalog.ts 的 MENTION_ALL */
  mentions?: string[];
}

export interface Limits {
  maxFileBytes: number;
  maxStickerBytes: number;
  maxAvatarBytes: number;
}

/** 存储空间的使用情况。level：ok 正常，warn 用了 80% 以上，full 已满（暂停发消息和文件） */
export interface StorageInfo {
  used: number;
  limit: number;
  level: 'ok' | 'warn' | 'full';
  /** 每次升到 warn 或 full 时加 1。浏览器记住弹过的编号，保证每次只弹一回 */
  alertId: number;
}

/** GET /api/session 的返回值：前端渲染页面需要的全部初始数据 */
export interface SessionInfo {
  me: UserInfo;
  users: UserInfo[];
  /** 每个会话最近的一部分消息，更早的通过 /api/messages 分页加载 */
  messages: ChatMessage[];
  /** 还有更早消息没加载的会话：全组是 all，私聊是对方的 id */
  older: string[];
  stickers: CustomSticker[];
  limits: Limits;
  /** 自己给同事设置的备注，只有自己能看到。键是同事 id */
  remarks: Record<string, string>;
  storage: StorageInfo;
  /** 在服务器电脑上用 localhost 打开时为 true，可以清理任何人的文件 */
  admin: boolean;
}

/** GET /api/messages 的返回值：某个会话里更早的一页消息 */
export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

/** 存储空间管理里列出的一个文件 */
export interface StoredFileInfo {
  id: string;
  /** 管理员查看别人的私聊文件时，文件名会被隐藏 */
  name: string;
  size: number;
  owner: string;
  ownerName: string;
  at: number;
  /** 文件在哪个会话：“全组”，或者“张三 ↔ 李四” */
  where: string;
  image?: ImageType;
  canDelete: boolean;
}

/** 搜索结果：消息本身，以及它属于哪个会话（全组是 all，私聊是对方的 id） */
export interface SearchHit {
  conversation: string;
  message: ChatMessage;
}

/** 通过 SSE 推送给浏览器的事件。message 既表示新消息，也表示投票等消息的状态更新 */
export type ServerEvent =
  | { type: 'users'; users: UserInfo[] }
  | { type: 'message'; message: ChatMessage }
  /** 消息被发送者撤回，服务器上已经删除 */
  | { type: 'deleted'; id: string }
  | { type: 'stickers'; stickers: CustomSticker[] }
  | { type: 'storage'; storage: StorageInfo }
  /** 只发给设置备注的本人，其他标签页同步更新 */
  | { type: 'remarks'; remarks: Record<string, string> };
