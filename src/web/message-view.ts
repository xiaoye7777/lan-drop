// 一条消息的显示：文字（链接、@）、文件卡片、表情、互动卡片、引用、转发的聊天记录、拍一拍，
// 以及消息上的操作菜单。消息列表怎么排、什么时候重画由 app.ts 负责。
import { MENTION_ALL } from '../shared/catalog.js';
import type { ChatMessage, FileMeta, ForwardBundle, ForwardItem, ReplyRef, UserInfo } from '../shared/types.js';
import { renderGomoku, renderPoll, renderRelay, renderWheel } from './activities.js';
import { bubbleClass, renderAvatar } from './components.js';
import { h, openDialog } from './dom.js';
import { BUBBLE_EFFECT_MS, effectInfo } from './effects.js';
import { fileExtension, formatDateTime, formatSize, formatTime } from './format.js';
import { openMenu, openMenuAt } from './menu.js';
import type { MenuItem } from './menu.js';
import { openImagePreview } from './preview.js';
import { animationElapsed, displayName, mentionsMe, state, userById } from './state.js';
import { renderSticker, STICKER_PLAY_MS } from './stickers.js';

/** 拍一拍那一行文字抖动的时长 */
const NUDGE_SHAKE_MS = 700;
/** 单击头像后等这么久，没有第二下才算单击（双击是拍一拍） */
const DOUBLE_CLICK_MS = 250;

/** 消息上的操作，由 app.ts 提供 */
export interface MessageActions {
  openUser(userId: string): void;
  nudge(userId: string): void;
  reply(message: ChatMessage): void;
  copy(message: ChatMessage): void;
  forward(message: ChatMessage): void;
  startSelect(message: ChatMessage): void;
  toggleSelect(message: ChatMessage): void;
  recall(message: ChatMessage): void;
  jumpTo(messageId: string): void;
  replayEffect(message: ChatMessage): void;
}

let actions: MessageActions;

export function setMessageActions(value: MessageActions): void {
  actions = value;
}

/** 能直接转发（逐条）的消息：文字、表情、没被清理的文件、聊天记录 */
export function isForwardable(message: ChatMessage): boolean {
  return (
    message.text !== undefined ||
    Boolean(message.sticker) ||
    Boolean(message.file && !message.file.removed) ||
    Boolean(message.forward)
  );
}

// ---------- 文字：链接和 @ ----------

const URL_PATTERN = String.raw`https?://[^\s<>"'，。！？、；：（）【】《》]+`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把文字里的网址变成链接，把 @ 到的人高亮。
 * 全部用 textContent 写入，消息里的 HTML 不会被执行；链接只认 http 和 https。
 */
export function renderRichText(text: string, mentions: string[] = []): Node[] {
  const names = new Map<string, boolean>();
  for (const id of mentions) {
    if (id === MENTION_ALL) names.set('所有人', true);
    else {
      const name = userById(id)?.name;
      if (name) names.set(name, id === state.me?.id);
    }
  }
  const mentionPattern = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => `@${escapeRegExp(name)}`)
    .join('|');
  const pattern = new RegExp(mentionPattern ? `(${URL_PATTERN})|(${mentionPattern})` : `(${URL_PATTERN})`, 'g');

  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    if (match[1]) {
      nodes.push(h('a', { className: 'link', href: match[1], target: '_blank', rel: 'noopener noreferrer' }, match[1]));
    } else {
      const name = match[0].slice(1);
      const isMe = names.get(name) === true || name === '所有人';
      nodes.push(h('span', { className: isMe ? 'mention mention-me' : 'mention' }, match[0]));
    }
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** 文字气泡：样式用发送者选的气泡，再叠加消息特效 */
function renderTextBubble(message: ChatMessage, sender: UserInfo | undefined): HTMLElement {
  const bubble = h(
    'div',
    { className: bubbleClass(sender?.bubble) },
    h('span', { className: 'bubble-text' }, ...renderRichText(message.text ?? '', message.mentions)),
  );
  const effect = effectInfo(message.effect);
  if (effect?.id === 'ink' && !state.revealedInk.has(message.id)) {
    // 隐形墨水：内容被遮住，点一下才显示
    const reveal = () => {
      state.revealedInk.add(message.id);
      bubble.classList.remove('fx-ink');
      bubble.removeAttribute('role');
      bubble.removeAttribute('tabindex');
      bubble.removeAttribute('aria-label');
    };
    bubble.classList.add('fx-ink');
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('tabindex', '0');
    bubble.setAttribute('aria-label', '隐形墨水消息，点击显示');
    bubble.addEventListener('click', reveal);
    bubble.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
  } else if (effect?.kind === 'bubble' && BUBBLE_EFFECT_MS[effect.id]) {
    const elapsed = animationElapsed(message.id, BUBBLE_EFFECT_MS[effect.id]);
    if (elapsed !== null) {
      // 负的延迟：重画时从已经播放到的位置接着播
      bubble.classList.add(`fx-${effect.id}`);
      bubble.style.animationDelay = `-${elapsed}ms`;
    }
  }
  return bubble;
}

// ---------- 文件 ----------

export function renderFileCard(file: FileMeta): HTMLElement {
  const removed = Boolean(file.removed);
  const preview =
    file.image && !removed
      ? h(
          'button',
          { className: 'file-thumb', type: 'button', 'aria-label': `查看大图 ${file.name}`, onclick: () => openImagePreview(file) },
          h('img', { src: `/api/files/${file.id}/preview`, alt: '', loading: 'lazy', decoding: 'async' }),
        )
      : null;
  return h(
    'div',
    { className: `file-card${removed ? ' file-removed' : ''}${preview ? ' has-thumb' : ''}` },
    preview,
    h(
      'div',
      { className: 'file-row' },
      h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(file.name)),
      h(
        'div',
        { className: 'file-info' },
        h('div', { className: 'file-name', title: file.name }, file.name),
        h('div', { className: 'file-detail' }, removed ? `${formatSize(file.size)} · 已被清理，无法下载` : formatSize(file.size)),
      ),
      !removed &&
        h('a', { className: 'btn btn-ghost btn-small', href: `/api/files/${file.id}`, download: file.name, 'aria-label': `下载 ${file.name}` }, '下载'),
    ),
  );
}

// ---------- 引用 ----------

function renderReplyQuote(reply: ReplyRef): HTMLElement {
  const text = reply.recalled ? '引用的消息已撤回' : `${displayName(reply.from, reply.fromName)}：${reply.summary}`;
  return h(
    'button',
    {
      className: `reply-quote${reply.recalled ? ' reply-recalled' : ''}`,
      type: 'button',
      title: reply.recalled ? undefined : '跳到原消息',
      disabled: reply.recalled,
      onclick: () => actions.jumpTo(reply.id),
    },
    text,
  );
}

// ---------- 合并转发的聊天记录 ----------

function itemSummary(item: ForwardItem): string {
  if (item.text !== undefined) return item.text.replace(/\s+/g, ' ');
  if (item.sticker) return '[表情]';
  if (item.file) return `${item.file.image ? '[图片]' : '[文件]'} ${item.file.name}`;
  return item.summary ?? '';
}

function renderForwardCard(bundle: ForwardBundle): HTMLElement {
  return h(
    'button',
    { className: 'card forward-card', type: 'button', onclick: () => openForwardViewer(bundle) },
    h('span', { className: 'forward-title' }, bundle.title),
    h(
      'span',
      { className: 'forward-lines' },
      ...bundle.items.slice(0, 4).map((item) => h('span', { className: 'forward-line' }, `${displayName(item.from, item.fromName)}：${itemSummary(item)}`)),
    ),
    h('span', { className: 'card-foot' }, `聊天记录 · 共 ${bundle.items.length} 条`),
  );
}

function renderForwardItem(item: ForwardItem): HTMLElement {
  let content: HTMLElement;
  if (item.text !== undefined) content = h('div', { className: 'forward-text' }, ...renderRichText(item.text));
  else if (item.sticker) content = renderSticker(item.sticker, false);
  else if (item.file) content = renderFileCard(item.file);
  else content = h('div', { className: 'forward-summary' }, item.summary ?? '');
  return h(
    'li',
    { className: 'forward-item' },
    h('div', { className: 'forward-meta' }, `${displayName(item.from, item.fromName)} · ${formatDateTime(item.at)}`),
    content,
  );
}

export function openForwardViewer(bundle: ForwardBundle): void {
  const dialog = openDialog(
    'forward-viewer',
    h('h2', {}, bundle.title),
    h('ol', { className: 'forward-list' }, ...bundle.items.map(renderForwardItem)),
    h(
      'div',
      { className: 'dialog-actions' },
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '关闭'),
    ),
  );
}

// ---------- 拍一拍 ----------

function nudgeText(message: ChatMessage): string {
  const nudge = message.nudge!;
  const meId = state.me?.id;
  const actor = message.from === meId ? '我' : displayName(message.from, message.fromName);
  const target =
    nudge.target === meId ? '我' : nudge.target === message.from ? '自己' : displayName(nudge.target, nudge.targetName);
  return `${actor} 拍了拍 ${target}${nudge.suffix}`;
}

function renderNudge(message: ChatMessage): HTMLElement {
  const mine = message.from === state.me?.id;
  const line = h('span', { className: 'nudge-text' }, nudgeText(message));
  const elapsed = animationElapsed(message.id, NUDGE_SHAKE_MS);
  if (elapsed !== null) {
    line.classList.add('nudge-shake');
    line.style.animationDelay = `-${elapsed}ms`;
  }
  return h(
    'div',
    { className: 'system-line', 'data-id': message.id },
    line,
    mine && h('button', { className: 'link-btn', type: 'button', onclick: () => actions.recall(message) }, '撤回'),
  );
}

// ---------- 整条消息 ----------

function renderContent(message: ChatMessage, sender: UserInfo | undefined): HTMLElement {
  if (message.file) return renderFileCard(message.file);
  if (message.sticker) return renderSticker(message.sticker, animationElapsed(message.id, STICKER_PLAY_MS) !== null);
  if (message.poll) return renderPoll(message);
  if (message.relay) return renderRelay(message);
  if (message.wheel) return renderWheel(message);
  if (message.gomoku) return renderGomoku(message);
  if (message.forward) return renderForwardCard(message.forward);
  return renderTextBubble(message, sender);
}

function menuItems(message: ChatMessage): MenuItem[] {
  const items: MenuItem[] = [{ label: '引用', onSelect: () => actions.reply(message) }];
  if (message.text !== undefined) items.push({ label: '复制', onSelect: () => actions.copy(message) });
  if (isForwardable(message)) items.push({ label: '转发', onSelect: () => actions.forward(message) });
  items.push({ label: '多选', onSelect: () => actions.startSelect(message) });
  if (message.from === state.me?.id) items.push({ label: '撤回', onSelect: () => actions.recall(message), danger: true });
  return items;
}

/** 头像：单击看资料，双击拍一拍 */
function renderMessageAvatar(message: ChatMessage, sender: UserInfo | undefined): HTMLElement {
  const author = sender ?? { id: message.from, name: message.fromName, avatar: null };
  let clickTimer: number | undefined;
  return h(
    'button',
    {
      className: 'message-avatar',
      type: 'button',
      title: sender ? '单击查看资料，双击拍一拍' : undefined,
      'aria-label': `查看 ${displayName(message.from, message.fromName)} 的资料`,
      disabled: !sender,
      onclick: () => {
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => actions.openUser(message.from), DOUBLE_CLICK_MS);
      },
      ondblclick: () => {
        window.clearTimeout(clickTimer);
        actions.nudge(message.from);
      },
    },
    renderAvatar(author, 'sm'),
  );
}

export function renderMessage(message: ChatMessage): HTMLElement {
  if (message.nudge) return renderNudge(message);

  const mine = message.from === state.me?.id;
  const sender = userById(message.from);
  const effect = effectInfo(message.effect);
  const selected = state.selected.has(message.id);
  const classes = ['message'];
  if (mine) classes.push('message-mine');
  if (mentionsMe(message)) classes.push('message-mentioned');
  if (state.selecting) classes.push(selected ? 'message-selectable message-selected' : 'message-selectable');
  if (state.highlight === message.id) classes.push('message-flash');

  const menuButton = h(
    'button',
    { className: 'msg-menu-btn', type: 'button', 'aria-label': '更多操作', title: '更多操作' },
    '···',
  );
  menuButton.addEventListener('click', () => openMenuAt(menuButton, menuItems(message)));

  const row = h(
    'div',
    { className: classes.join(' '), 'data-id': message.id },
    state.selecting && h('span', { className: 'select-box', 'aria-hidden': 'true' }),
    renderMessageAvatar(message, sender),
    h(
      'div',
      { className: 'message-body' },
      h(
        'div',
        { className: 'message-meta' },
        mine ? formatTime(message.at) : `${displayName(message.from, message.fromName)} · ${formatTime(message.at)}`,
        mentionsMe(message) && h('span', { className: 'mention-tag' }, '@了你'),
        !state.selecting && menuButton,
      ),
      message.reply && renderReplyQuote(message.reply),
      renderContent(message, sender),
      effect &&
        h(
          'button',
          { className: 'effect-tag', type: 'button', title: '重播特效', onclick: () => actions.replayEffect(message) },
          `✨ ${effect.name} · 重播`,
        ),
    ),
  );

  if (state.selecting) {
    // 多选时点整行就是勾选，里面的按钮和链接都不响应
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(selected));
    row.tabIndex = 0;
    row.addEventListener('click', () => actions.toggleSelect(message));
    row.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        actions.toggleSelect(message);
      }
    });
  } else {
    // 右键打开同样的菜单。选中了文字或点在链接、图片上时，保留浏览器自己的菜单（方便复制、另存）
    row.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement;
      if (window.getSelection()?.toString() || target.closest('a, img, input, textarea')) return;
      event.preventDefault();
      openMenu(event.clientX, event.clientY, menuItems(message));
    });
  }
  return row;
}
