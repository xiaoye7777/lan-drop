// 页面的全部状态，以及从状态推算出来的常用信息。
// 各模块直接读写 state；改完后调用 rerender() 让主界面重画。
import type {
  ChatMessage,
  CustomSticker,
  GroupRecipient,
  Limits,
  Recipient,
  UserInfo,
} from '../shared/types.js';
import { ApiError } from './api.js';
import { messageOf, showToast } from './dom.js';
import { playScreenEffect } from './effects.js';

export const GROUP: GroupRecipient = 'all';

export const state = {
  me: null as UserInfo | null,
  users: [] as UserInfo[],
  messages: new Map<string, ChatMessage>(),
  stickers: [] as CustomSticker[],
  limits: { maxFileBytes: 0, maxStickerBytes: 0, maxAvatarBytes: 0 } as Limits,
  /** 当前打开的会话：全组，或私聊对方的 id */
  active: GROUP as Recipient,
  /**
   * 正在播放动画的消息和开始时间。消息列表重画时据此接着播放，
   * 而不是从头开始或者突然停住。
   */
  animations: new Map<string, number>(),
  /** 已经点开看过的隐形墨水消息 */
  revealedInk: new Set<string>(),
  /** 自己刚发了消息，下次重画时滚到最底部 */
  stickToBottom: false,
};

export function userById(id: string): UserInfo | undefined {
  return state.users.find((user) => user.id === id);
}

/** 一条消息属于哪个会话：全组，或私聊的对方 */
export function conversationOf(message: ChatMessage): Recipient {
  if (message.to === GROUP) return GROUP;
  return message.from === state.me?.id ? message.to : message.from;
}

export function conversationMessages(conversation: Recipient): ChatMessage[] {
  return [...state.messages.values()]
    .filter((message) => conversationOf(message) === conversation)
    .sort((a, b) => a.at - b.at);
}

export function conversationName(conversation: Recipient): string {
  if (conversation === GROUP) return '全组';
  return userById(conversation)?.name ?? '已离开的同事';
}

/**
 * 收到服务器返回的消息后存起来并重画。同一条消息可能收到多次（自己发送的响应、推送、状态更新），
 * 只有第一次收到时才播放特效和动画；历史消息不经过这里，所以不会重播。
 */
export function applyMessage(message: ChatMessage): void {
  const isNew = !state.messages.has(message.id);
  state.messages.set(message.id, message);
  if (isNew) {
    const visible = conversationOf(message) === state.active && document.visibilityState === 'visible';
    if (message.effect || message.wheel || message.sticker) state.animations.set(message.id, performance.now());
    if (message.effect && visible) playScreenEffect(message.effect);
    if (message.from === state.me?.id) state.stickToBottom = true;
  }
  rerender();
}

/** 动画已经播放了多久（毫秒）；没在播放或已经播完时返回 null */
export function animationElapsed(id: string, duration: number): number | null {
  const start = state.animations.get(id);
  if (start === undefined) return null;
  const elapsed = performance.now() - start;
  if (elapsed >= duration) {
    state.animations.delete(id);
    return null;
  }
  return elapsed;
}

// ---------- 重画和错误处理的挂钩，由 app.ts 注册 ----------

let renderHook = (): void => undefined;
let unauthorizedHook = (): void => undefined;

export function onRender(fn: () => void): void {
  renderHook = fn;
}

export function onUnauthorized(fn: () => void): void {
  unauthorizedHook = fn;
}

export function rerender(): void {
  renderHook();
}

/** 统一处理请求失败：登录失效回到登录页，其他错误弹出提示 */
export function handleError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) unauthorizedHook();
  else showToast(messageOf(error));
}
