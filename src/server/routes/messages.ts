// 发消息（文字、表情、投票、接龙、大转盘、五子棋）、对消息的后续操作、撤回、
// 转发、拍一拍，以及历史消息分页和搜索
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BUILTIN_STICKERS, EFFECT_IDS, LIMITS, MENTION_ALL, summarize } from '../../shared/catalog.js';
import type { ChatMessage, ForwardItem, Recipient, ReplyRef } from '../../shared/types.js';
import { applyAction, createGomoku, createPoll, createRelay, createWheel } from '../activities.js';
import type { AppContext, Route, RouteParams } from '../context.js';
import { ID } from '../context.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { GROUP_RECIPIENT } from '../store.js';
import type { MessageContent, StoredUser } from '../store.js';

/** 两次拍一拍之间至少间隔多久，防止刷屏 */
const NUDGE_INTERVAL_MS = 3000;

/** 一组不重复的字符串，数量在范围内；否则返回 null */
function stringList(value: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  const list = [...new Set(value as string[])];
  return list.length === value.length ? list : null;
}

/** 合并转发时一条消息的样子：文字、表情、文件原样保留，其他内容只留一句说明 */
function toForwardItem(message: ChatMessage): ForwardItem {
  const base = { from: message.from, fromName: message.fromName, at: message.at };
  if (message.text !== undefined) return { ...base, text: message.text };
  if (message.sticker) return { ...base, sticker: { ...message.sticker } };
  if (message.file && !message.file.removed) return { ...base, file: { ...message.file } };
  const summary = summarize(message);
  return { ...base, summary: message.file?.removed ? `${summary}（已清理）` : summary };
}

/** 逐条转发时复制的内容。投票、五子棋这类互动消息复制不了，返回 null */
function copyContent(message: ChatMessage): MessageContent | null {
  if (message.text !== undefined) return { text: message.text };
  if (message.sticker) return { sticker: { ...message.sticker } };
  if (message.file && !message.file.removed) return { file: { ...message.file } };
  if (message.forward) return { forward: structuredClone(message.forward) };
  return null;
}

export function messageRoutes(ctx: AppContext): Route[] {
  const { store } = ctx;
  const lastNudge = new Map<string, number>();

  /** 找到当前用户能看到的消息。看不到的和不存在的返回同样的结果，不暴露消息是否存在 */
  function visibleMessage(user: StoredUser, id: unknown): ChatMessage {
    const message = typeof id === 'string' ? store.findMessage(id) : undefined;
    if (!message || !store.canView(message, user.id)) throw new HttpError(404, '消息不存在');
    return message;
  }

  function recipientOf(value: unknown): Recipient {
    const to = typeof value === 'string' ? value : '';
    if (!store.isValidRecipient(to)) throw new HttpError(400, '找不到接收人');
    return to;
  }

  /** 引用回复：被引用的消息必须在同一个会话里。保存的是服务器生成的摘要，不信任浏览器传来的内容 */
  function buildReply(value: unknown, user: StoredUser, to: Recipient): ReplyRef {
    const target = visibleMessage(user, value);
    if (store.conversationFor(target, user.id) !== to) throw new HttpError(400, '只能引用同一个会话里的消息');
    return { id: target.id, from: target.from, fromName: target.fromName, summary: summarize(target) };
  }

  /** @ 的人必须是存在的同事，或者“所有人”。只有全组消息才有 @ */
  function buildMentions(value: unknown): string[] {
    const list = stringList(value, 0, LIMITS.maxMentions);
    if (!list || !list.every((id) => id === MENTION_ALL || store.getUser(id))) throw new HttpError(400, '@ 的人不存在');
    return list;
  }

  /** 请求体里只能有一种内容，根据它构造消息内容并校验 */
  function buildContent(body: Record<string, unknown>, user: StoredUser, to: Recipient): MessageContent {
    const kinds = ['text', 'sticker', 'poll', 'relay', 'wheel', 'gomoku'].filter((key) => body[key] !== undefined);
    if (kinds.length !== 1) throw new HttpError(400, '请求格式不正确');

    switch (kinds[0]) {
      case 'text': {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) throw new HttpError(400, '消息不能为空');
        if (text.length > LIMITS.textLength) throw new HttpError(400, `消息不能超过 ${LIMITS.textLength} 个字`);
        const content: MessageContent = { text };
        if (body.effect !== undefined) {
          if (typeof body.effect !== 'string' || !EFFECT_IDS.has(body.effect)) throw new HttpError(400, '没有这个特效');
          content.effect = body.effect;
        }
        if (body.replyTo !== undefined) content.reply = buildReply(body.replyTo, user, to);
        if (body.mentions !== undefined && to === GROUP_RECIPIENT) {
          const mentions = buildMentions(body.mentions);
          if (mentions.length > 0) content.mentions = mentions;
        }
        return content;
      }
      case 'sticker': {
        const ref = body.sticker as { source?: unknown; id?: unknown } | null;
        const id = typeof ref?.id === 'string' ? ref.id : '';
        if (ref?.source === 'builtin' && BUILTIN_STICKERS.has(id)) return { sticker: { source: 'builtin', id } };
        if (ref?.source === 'custom' && store.findSticker(id)) return { sticker: { source: 'custom', id } };
        throw new HttpError(400, '表情不存在');
      }
      case 'poll':
        return { poll: createPoll(body.poll) };
      case 'relay':
        return { relay: createRelay(body.relay, user) };
      case 'wheel':
        return { wheel: createWheel(body.wheel) };
      default:
        return { gomoku: createGomoku(user) };
    }
  }

  async function postMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = ctx.requireUser(req);
    ctx.requireStorage();
    const body = await readJson(req);
    const to = recipientOf(body.to);
    const message = store.addMessage(user, to, buildContent(body, user, to));
    ctx.publish(message);
    sendJson(res, 200, message);
  }

  async function act(req: IncomingMessage, res: ServerResponse, { match }: RouteParams): Promise<void> {
    const user = ctx.requireUser(req);
    const message = visibleMessage(user, match[1]);
    applyAction(message, user, await readJson(req));
    store.saveMessageChange();
    ctx.publish(message);
    sendJson(res, 200, message);
  }

  /** 撤回：只能撤回自己发的，不限时间，服务器上永久删除（带文件的连文件一起删） */
  function recall(req: IncomingMessage, res: ServerResponse, { match }: RouteParams): void {
    const user = ctx.requireUser(req);
    const message = visibleMessage(user, match[1]);
    if (message.from !== user.id) throw new HttpError(403, '只能撤回自己发的消息');
    const changed = store.deleteMessage(message);
    ctx.publishDeleted(message);
    // 引用了这条消息的回复，引用内容已被清空，通知大家更新
    changed.forEach(ctx.publish);
    sendJson(res, 200, { ok: true });
  }

  /**
   * 转发。merge 把选中的消息打包成一条“聊天记录”；single 逐条复制。
   * 选中的消息必须来自同一个会话，可以同时转给多个会话。
   */
  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = ctx.requireUser(req);
    ctx.requireStorage();
    const body = await readJson(req);
    const ids = stringList(body.ids, 1, LIMITS.forwardMaxItems);
    const targets = stringList(body.to, 1, LIMITS.forwardMaxTargets);
    if (!ids || !targets || (body.mode !== 'merge' && body.mode !== 'single')) throw new HttpError(400, '请求格式不正确');
    targets.forEach(recipientOf);

    const selected = store.chronological(ids.map((id) => visibleMessage(user, id)));
    const conversation = store.conversationFor(selected[0], user.id);
    if (selected.some((message) => store.conversationFor(message, user.id) !== conversation)) {
      throw new HttpError(400, '只能转发同一个会话里的消息');
    }

    let contents: MessageContent[];
    if (body.mode === 'merge') {
      const peer = store.getUser(conversation)?.name ?? selected.find((message) => message.from === conversation)?.fromName;
      const title = conversation === GROUP_RECIPIENT ? '全组的聊天记录' : `${user.name}和${peer ?? '同事'}的聊天记录`;
      contents = [{ forward: { title, items: selected.map(toForwardItem) } }];
    } else {
      const copies = selected.map(copyContent);
      if (copies.some((content) => content === null)) {
        throw new HttpError(400, '投票、接龙、五子棋、拍一拍和已清理的文件不能逐条转发，可以用合并转发');
      }
      contents = copies as MessageContent[];
    }

    const created: ChatMessage[] = [];
    for (const to of targets) {
      for (const content of contents) {
        // 每条新消息各用一份拷贝，互不影响
        const message = store.addMessage(user, to, structuredClone(content));
        ctx.publish(message);
        created.push(message);
      }
    }
    sendJson(res, 200, { messages: created });
  }

  /** 拍一拍：在全组可以拍任何人，私聊里只能拍对方或自己 */
  async function nudge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = ctx.requireUser(req);
    ctx.requireStorage();
    const body = await readJson(req);
    const to = recipientOf(body.to);
    const target = typeof body.target === 'string' ? store.getUser(body.target) : undefined;
    if (!target) throw new HttpError(400, '找不到这位同事');
    if (to !== GROUP_RECIPIENT && target.id !== to && target.id !== user.id) throw new HttpError(400, '私聊里只能拍对方或自己');
    const last = lastNudge.get(user.id) ?? 0;
    if (Date.now() - last < NUDGE_INTERVAL_MS) throw new HttpError(429, '拍得太快了，歇一会儿');
    lastNudge.set(user.id, Date.now());
    const message = store.addMessage(user, to, {
      nudge: { target: target.id, targetName: target.name, suffix: target.nudgeSuffix ?? '' },
    });
    ctx.publish(message);
    sendJson(res, 200, message);
  }

  /** 往上翻时加载更早的消息：GET /api/messages?with=会话&before=已加载的最早一条消息的 id */
  function history(req: IncomingMessage, res: ServerResponse, { url }: RouteParams): void {
    const user = ctx.requireUser(req);
    const conversation = url.searchParams.get('with') ?? '';
    const before = url.searchParams.get('before') ?? '';
    const page = store.pageBefore(user.id, conversation, before, LIMITS.historyPage);
    if (!page) throw new HttpError(404, '消息不存在');
    sendJson(res, 200, page);
  }

  function search(req: IncomingMessage, res: ServerResponse, { url }: RouteParams): void {
    const user = ctx.requireUser(req);
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) throw new HttpError(400, '请输入要搜索的内容');
    if ([...query].length > LIMITS.searchQueryLength) throw new HttpError(400, '搜索内容太长');
    sendJson(res, 200, { hits: store.search(user.id, query, LIMITS.searchMaxResults) });
  }

  return [
    { method: 'POST', path: '/api/messages', handler: postMessage },
    { method: 'GET', path: '/api/messages', handler: history },
    { method: 'GET', path: '/api/search', handler: search },
    { method: 'POST', path: '/api/forward', handler: forward },
    { method: 'POST', path: '/api/nudge', handler: nudge },
    { method: 'POST', path: new RegExp(`^/api/messages/${ID}/actions$`), handler: act },
    { method: 'POST', path: new RegExp(`^/api/messages/${ID}/recall$`), handler: recall },
  ];
}
