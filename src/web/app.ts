// 页面主逻辑。结构是“状态 + 渲染函数”：状态变了就调用对应的 render 函数重画那一块。
// 一条消息长什么样在 message-view.ts；表情、特效、投票、转发、存储空间等功能在各自的模块里，
// 这里负责把它们组装起来：侧边栏、消息列表、输入栏、上传、服务器推送、登录。
import type { ChatMessage, Recipient, ServerEvent, SessionInfo, StickerRef } from '../shared/types.js';
import { EFFECTS, summarize } from '../shared/catalog.js';
import { openPollDialog, openRelayDialog, openWheelDialog, startGomoku } from './activities.js';
import * as api from './api.js';
import { applyChatBackground } from './chat-background.js';
import { nameplateClass, renderAvatar } from './components.js';
import { byId, confirmAction, h, messageOf, openDialog, readStorage, showToast, writeStorage } from './dom.js';
import { effectInfo, playScreenEffect } from './effects.js';
import { dayKey, fileExtension, formatDay, formatSize } from './format.js';
import { openForwardDialog } from './forward.js';
import { collectMentions, createMentionPicker } from './mentions.js';
import { closeMenu } from './menu.js';
import { isForwardable, renderMessage, setMessageActions } from './message-view.js';
import { openMyProfile, openUserCard } from './profile.js';
import { openSearchDialog } from './search.js';
import {
  applyMessage,
  conversationMessages,
  conversationName,
  conversationOf,
  displayName,
  GROUP,
  handleError,
  mentionsMe,
  onRender,
  onUnauthorized,
  state,
  userById,
} from './state.js';
import { createStickerPanel } from './stickers.js';
import { maybeAlertStorage, openStorageDialog, renderStorageBanner, renderStorageMeter } from './storage.js';

const APP_TITLE = '内网快传';
const READ_MARKS_KEY = 'lan-drop-read-marks';
const THEME_KEY = 'lan-drop-theme';
/** 距离底部小于这个值时，新消息到来会自动滚到底 */
const STICK_TO_BOTTOM_PX = 80;
/** 滚到离顶部这么近时，自动加载更早的消息 */
const LOAD_OLDER_PX = 80;
/** 跳到某条消息时，最多往前翻这么多页 */
const JUMP_MAX_PAGES = 50;
/** 被跳到的消息闪烁提示的时长 */
const HIGHLIGHT_MS = 2000;

// ---------- 页面元素 ----------

const loginView = byId('login-view');
const loginForm = byId<HTMLFormElement>('login-form');
const loginName = byId<HTMLInputElement>('login-name');
const loginCode = byId<HTMLInputElement>('login-code');
const loginError = byId('login-error');
const loginSubmit = byId<HTMLButtonElement>('login-submit');
const loginInsecure = byId('login-insecure');
const workspaceView = byId('workspace-view');
const conversationsEl = byId('conversations');
const insecureBadge = byId<HTMLButtonElement>('insecure-badge');
const storageMeter = byId<HTMLButtonElement>('storage-meter');
const profileButton = byId<HTMLButtonElement>('profile-button');
const chatTitle = byId<HTMLButtonElement>('chat-title');
const chatSubtitle = byId('chat-subtitle');
const searchButton = byId<HTMLButtonElement>('search-button');
const banner = byId('connection-banner');
const storageBanner = byId('storage-banner');
const messagesEl = byId('messages');
const composer = byId<HTMLFormElement>('composer');
const fileInput = byId<HTMLInputElement>('file-input');
const messageInput = byId<HTMLTextAreaElement>('message-input');
const sendButton = byId<HTMLButtonElement>('send-button');
const stickerButton = byId<HTMLButtonElement>('sticker-button');
const moreButton = byId<HTMLButtonElement>('more-button');
const moreMenu = byId('more-menu');
const effectButton = byId<HTMLButtonElement>('effect-button');
const effectMenu = byId('effect-menu');
const effectChip = byId('effect-chip');
const replyChip = byId('reply-chip');
const selectBar = byId('select-bar');
const selectCount = byId('select-count');
const forwardMergeButton = byId<HTMLButtonElement>('forward-merge');
const forwardSingleButton = byId<HTMLButtonElement>('forward-single');
const dropOverlay = byId('drop-overlay');
const dropText = byId('drop-text');

/** 用 http:// 打开、又不是在本机打开时，传输没有加密 */
const insecure = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const secureUrl = `https://${location.host}${location.pathname}`;

// ---------- 上传队列 ----------

/** 一个待发送或发送中的文件。发送成功后会被移除，由正式的文件消息取代 */
interface Upload {
  id: string;
  file: File;
  to: Recipient;
  status: 'queued' | 'uploading' | 'failed';
  progress: number;
  error?: string;
  /** 文件超过大小限制时重试也没用，不显示重试按钮 */
  retryable: boolean;
  handle?: api.UploadHandle<ChatMessage>;
}

let uploads: Upload[] = [];
let events: EventSource | null = null;
let isSending = false;
/** 选好、还没发出去的消息特效 */
let pendingEffect: string | null = null;
/** 上次画消息列表时同事们的头像、昵称、气泡，变了才需要重画消息 */
let lastUserLook = '';
/** 每个会话没发出去的草稿，切换会话时保存和恢复 */
const drafts = new Map<Recipient, string>();
/** 正在加载更早消息的会话 */
let loadingOlder: Recipient | null = null;

// ---------- 未读 ----------

/**
 * 已读位置按会话记录在浏览器里，存的是服务器时间，这样不受同事电脑时钟不准的影响。
 * firstSeen 是这个浏览器第一次打开时的最新消息时间，更早的历史消息不算未读。
 */
interface ReadMarks {
  firstSeen?: number;
  conversations: Record<string, number>;
}

function loadReadMarks(): ReadMarks {
  try {
    const parsed = JSON.parse(readStorage(READ_MARKS_KEY) ?? '') as ReadMarks;
    if (parsed && typeof parsed.conversations === 'object') return parsed;
  } catch {
    // 没有记录或记录损坏，从头开始
  }
  return { conversations: {} };
}

let readMarks = loadReadMarks();

function isUnread(message: ChatMessage): boolean {
  if (message.from === state.me?.id) return false;
  const mark = readMarks.conversations[conversationOf(message)] ?? readMarks.firstSeen ?? 0;
  return message.at > mark;
}

function unreadMessages(conversation: Recipient): ChatMessage[] {
  return conversationMessages(conversation).filter(isUnread);
}

/** 当前会话正在被看时，把它标记为已读 */
function markActiveAsRead(): void {
  if (document.visibilityState !== 'visible') return;
  const latest = conversationMessages(state.active).at(-1);
  if (latest && latest.at > (readMarks.conversations[state.active] ?? 0)) {
    readMarks.conversations[state.active] = latest.at;
    writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  }
}

// 页面在后台且有未读时让标题闪烁；有人 @ 我时标题直接说出来
let titleFlashOn = false;

function updateTitle(): void {
  const unread = [...state.messages.values()].filter(isUnread);
  if (unread.length === 0) {
    document.title = APP_TITLE;
    return;
  }
  const flash = document.visibilityState === 'hidden' && titleFlashOn;
  const label = unread.some(mentionsMe) ? '【有人@我】' : '【新消息】';
  document.title = flash ? label : `(${unread.length}) ${APP_TITLE}`;
}

window.setInterval(() => {
  titleFlashOn = !titleFlashOn;
  updateTitle();
}, 1000);

// ---------- 渲染：侧边栏 ----------

/** 会话下面那行小字：有人 @ 我、有草稿时优先显示 */
function conversationMeta(id: Recipient, fallback: string): (Node | string)[] {
  if (id !== state.active) {
    if (unreadMessages(id).some(mentionsMe)) return [h('span', { className: 'meta-flag' }, '[有人@我]'), ` ${fallback}`];
    const draft = drafts.get(id);
    if (draft) return [h('span', { className: 'meta-flag' }, '[草稿]'), ` ${draft}`];
  }
  return [fallback];
}

function renderConversationButton(id: Recipient, name: string, meta: string, avatar: HTMLElement, nameplate?: string): HTMLElement {
  const unread = id === state.active ? 0 : unreadMessages(id).length;
  return h(
    'button',
    {
      className: `conversation ${nameplateClass(nameplate)}`,
      type: 'button',
      'aria-current': String(id === state.active),
      onclick: () => selectConversation(id),
    },
    avatar,
    h(
      'span',
      { className: 'conversation-text' },
      h('span', { className: 'conversation-name' }, name),
      h('span', { className: 'conversation-meta' }, ...conversationMeta(id, meta)),
    ),
    unread > 0 && h('span', { className: 'unread-badge', 'aria-label': `${unread} 条未读` }, unread > 99 ? '99+' : String(unread)),
  );
}

function renderSidebar(): void {
  const others = state.users
    .filter((user) => user.id !== state.me?.id)
    .sort((a, b) => Number(b.online) - Number(a.online) || displayName(a.id).localeCompare(displayName(b.id), 'zh'));
  const onlineCount = state.users.filter((user) => user.online).length;
  const groupAvatar = h('span', { className: 'avatar avatar-md avatar-group', 'aria-hidden': 'true' }, '全');

  const nodes: Node[] = [
    renderConversationButton(GROUP, '全组', `${onlineCount} 人在线`, groupAvatar),
    h('div', { className: 'section-label' }, '同事'),
    ...others.map((user) =>
      renderConversationButton(
        user.id,
        displayName(user.id),
        user.bio || `${user.online ? '在线' : '离线'} · ${user.ip}`,
        renderAvatar(user, 'md', user.online),
        user.nameplate,
      ),
    ),
  ];
  if (others.length === 0) nodes.push(h('div', { className: 'empty-hint' }, '同事登录后会显示在这里'));
  conversationsEl.replaceChildren(...nodes);

  const me = state.me;
  if (me) {
    profileButton.className = `profile-button ${nameplateClass(me.nameplate)}`;
    profileButton.replaceChildren(
      renderAvatar(me, 'md', true),
      h(
        'span',
        { className: 'conversation-text' },
        h('span', { className: 'conversation-name' }, me.name),
        h('span', { className: 'conversation-meta' }, '个人主页'),
      ),
    );
  }
  renderStorageMeter(storageMeter);
}

// ---------- 渲染：聊天区 ----------

function renderChatHead(): void {
  const user = userById(state.active);
  chatTitle.textContent = conversationName(state.active);
  chatTitle.disabled = !user;
  if (state.active === GROUP) {
    chatSubtitle.textContent = `共 ${state.users.length} 人，${state.users.filter((item) => item.online).length} 人在线`;
  } else if (user) {
    const status = user.online ? '在线' : '离线，上线后能收到';
    const nickname = state.remarks[user.id] ? `昵称 ${user.name}` : '';
    chatSubtitle.textContent = [nickname, status, user.ip, user.bio].filter(Boolean).join(' · ');
  } else {
    chatSubtitle.textContent = '';
  }
  messageInput.placeholder =
    state.storage.level === 'full'
      ? '存储空间已满，暂时不能发送'
      : `发消息给${conversationName(state.active)}（Enter 发送，可以粘贴截图${state.active === GROUP ? '，@ 提到同事' : ''}）`;
}

function replayEffect(message: ChatMessage): void {
  state.revealedInk.delete(message.id);
  state.animations.set(message.id, performance.now());
  if (message.effect) playScreenEffect(message.effect);
  renderMessages();
}

/** 撤回自己的消息：确认后服务器永久删除，所有人那边同时消失 */
async function recallMessage(message: ChatMessage): Promise<void> {
  const ok = await confirmAction(
    '撤回这条消息？',
    message.file
      ? '撤回后所有人都看不到，服务器上的文件也会一起删除，无法恢复。已经下载或转发出去的不受影响。'
      : '撤回后所有人都看不到，服务器上会永久删除，无法恢复。已经转发出去的不受影响。',
    '撤回',
  );
  if (!ok) return;
  try {
    await api.recall(message.id);
    removeMessage(message.id);
  } catch (error) {
    handleError(error);
  }
}

function removeMessage(id: string): void {
  state.messages.delete(id);
  state.animations.delete(id);
  state.revealedInk.delete(id);
  state.selected.delete(id);
  if (state.replyTo?.id === id) setReplyTo(null);
  renderAll();
}

function renderUpload(upload: Upload): HTMLElement {
  const failed = upload.status === 'failed';
  const detail = failed
    ? upload.error
    : upload.status === 'queued'
      ? `${formatSize(upload.file.size)} · 等待发送`
      : `${formatSize(upload.file.size)} · ${Math.round(upload.progress * 100)}%`;
  return h(
    'div',
    { className: 'message message-mine', 'data-upload': upload.id },
    h(
      'div',
      { className: 'message-body' },
      h(
        'div',
        { className: 'file-card' },
        h(
          'div',
          { className: 'file-row' },
          h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(upload.file.name)),
          h(
            'div',
            { className: 'file-info' },
            h('div', { className: 'file-name', title: upload.file.name }, upload.file.name),
            h('div', { className: failed ? 'file-detail file-detail-error' : 'file-detail' }, detail),
            !failed && h('div', { className: 'progress' }, h('div', { className: 'progress-bar' })),
          ),
          h(
            'div',
            { className: 'file-actions' },
            failed &&
              upload.retryable &&
              h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => retryUpload(upload) }, '重试'),
            h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => removeUpload(upload) }, failed ? '移除' : '取消'),
          ),
        ),
      ),
    ),
  );
}

/** 只更新进度条，不重画整个消息列表，否则上传时选中的文字会丢失 */
function updateUploadProgress(upload: Upload): void {
  const row = messagesEl.querySelector(`[data-upload="${upload.id}"]`);
  if (!row) return;
  const bar = row.querySelector<HTMLElement>('.progress-bar');
  const detail = row.querySelector<HTMLElement>('.file-detail');
  if (bar) bar.style.width = `${upload.progress * 100}%`;
  if (detail) detail.textContent = `${formatSize(upload.file.size)} · ${Math.round(upload.progress * 100)}%`;
}

interface RenderOptions {
  /** 滚到最底部 */
  forceBottom?: boolean;
  /** 保持离底部的距离不变：在上面插入了更早的消息时用，看着的内容不会跳 */
  keepFromBottom?: number;
}

function renderMessages(options: RenderOptions = {}): void {
  const distanceToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  const stick = options.forceBottom || state.stickToBottom || distanceToBottom < STICK_TO_BOTTOM_PX;
  state.stickToBottom = false;
  lastUserLook = userLook();

  const list = conversationMessages(state.active);
  const activeUploads = uploads.filter((upload) => upload.to === state.active);
  const nodes: Node[] = [];

  if (state.older.has(state.active)) {
    nodes.push(
      h(
        'button',
        { className: 'load-older', type: 'button', disabled: loadingOlder !== null, onclick: () => void loadOlderKeepingPosition() },
        loadingOlder ? '加载中…' : '查看更早的消息',
      ),
    );
  }
  if (list.length === 0 && activeUploads.length === 0) {
    nodes.push(h('div', { className: 'empty-chat' }, '还没有消息。可以直接输入文字、发表情、粘贴截图，或把文件拖到这里。'));
  }
  let lastDay = '';
  for (const message of list) {
    const key = dayKey(message.at);
    if (key !== lastDay) {
      nodes.push(h('div', { className: 'day-divider' }, h('span', {}, formatDay(message.at))));
      lastDay = key;
    }
    nodes.push(renderMessage(message));
  }
  nodes.push(...activeUploads.map(renderUpload));
  messagesEl.classList.toggle('selecting', state.selecting);
  messagesEl.replaceChildren(...nodes);
  activeUploads.filter((upload) => upload.status === 'uploading').forEach(updateUploadProgress);

  if (options.keepFromBottom !== undefined) messagesEl.scrollTop = messagesEl.scrollHeight - options.keepFromBottom;
  else if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 会影响消息显示的同事信息：头像、昵称、气泡 */
function userLook(): string {
  return state.users.map((user) => `${user.id}:${user.name}:${user.avatar}:${user.bubble}`).join('|');
}

function renderStorage(): void {
  renderStorageMeter(storageMeter);
  renderStorageBanner(storageBanner);
}

function renderAll(options: RenderOptions = {}): void {
  markActiveAsRead();
  renderSidebar();
  renderChatHead();
  renderStorage();
  renderMessages(options);
  renderSelectBar();
  updateTitle();
}

function selectConversation(conversation: Recipient): void {
  if (conversation !== state.active) {
    // 草稿留在原来的会话里，切回来还在
    const draft = messageInput.value.trim();
    if (draft) drafts.set(state.active, messageInput.value);
    else drafts.delete(state.active);
    state.active = conversation;
    messageInput.value = drafts.get(conversation) ?? '';
    resizeInput();
    setReplyTo(null);
    exitSelection(false);
  }
  closePopovers();
  renderAll({ forceBottom: true });
  messageInput.focus();
}

// ---------- 历史消息：往上翻时分页加载 ----------

/** 加载某个会话更早的一页消息。返回是否加载到了新消息 */
async function loadOlder(conversation: Recipient): Promise<boolean> {
  if (loadingOlder || !state.older.has(conversation)) return false;
  const oldest = conversationMessages(conversation)[0];
  if (!oldest) {
    state.older.delete(conversation);
    return false;
  }
  loadingOlder = conversation;
  try {
    const page = await api.fetchHistory(conversation, oldest.id);
    for (const message of page.messages) state.messages.set(message.id, message);
    if (!page.hasMore) state.older.delete(conversation);
    return page.messages.length > 0;
  } catch (error) {
    handleError(error);
    return false;
  } finally {
    loadingOlder = null;
  }
}

async function loadOlderKeepingPosition(): Promise<void> {
  const conversation = state.active;
  if (loadingOlder || !state.older.has(conversation)) return;
  const loading = loadOlder(conversation);
  // 先重画一次，把按钮变成“加载中…”
  renderMessages({ keepFromBottom: messagesEl.scrollHeight - messagesEl.scrollTop });
  await loading;
  if (state.active === conversation) renderMessages({ keepFromBottom: messagesEl.scrollHeight - messagesEl.scrollTop });
}

messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < LOAD_OLDER_PX && state.older.has(state.active) && !loadingOlder) {
    void loadOlderKeepingPosition();
  }
});

/** 跳到某条消息：切到它的会话，没加载的话往前翻，找到后滚过去并闪一下 */
async function jumpTo(messageId: string, conversation: Recipient = state.active): Promise<void> {
  if (conversation !== state.active) selectConversation(conversation);
  for (let page = 0; !state.messages.has(messageId) && page < JUMP_MAX_PAGES; page += 1) {
    if (!(await loadOlder(conversation))) break;
  }
  if (!state.messages.has(messageId)) {
    renderMessages();
    showToast('找不到这条消息，可能已经撤回了');
    return;
  }
  state.highlight = messageId;
  renderMessages();
  messagesEl.querySelector(`[data-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ block: 'center' });
  window.setTimeout(() => {
    if (state.highlight === messageId) state.highlight = null;
  }, HIGHLIGHT_MS);
}

// ---------- 消息上的操作 ----------

/**
 * 拍一拍。在全组里谁都能拍；私聊里只能拍对方或自己，
 * 所以在别的私聊里点了某人的“拍一拍”，就切到和他的私聊再拍
 */
async function nudgeUser(userId: string): Promise<void> {
  const ok = state.active === GROUP || state.active === userId || userId === state.me?.id;
  if (!ok) selectConversation(userId);
  try {
    applyMessage(await api.nudge(state.active, userId));
  } catch (error) {
    handleError(error);
  }
}

/** 复制文字。http:// 页面上浏览器不提供剪贴板接口，退回到老办法 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = h('textarea', { value: text, readOnly: true });
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('copy failed');
    }
    showToast('已复制');
  } catch {
    showToast('复制失败，请手动选中文字复制');
  }
}

function setReplyTo(message: ChatMessage | null): void {
  state.replyTo = message;
  replyChip.hidden = !message;
  if (!message) return;
  replyChip.replaceChildren(
    h('span', { className: 'chip-text' }, `回复 ${displayName(message.from, message.fromName)}：${summarize(message)}`),
    h('button', { className: 'chip-close', type: 'button', 'aria-label': '取消引用', onclick: () => setReplyTo(null) }, '×'),
  );
}

setMessageActions({
  openUser: (userId) => openUserCard(userId, { message: selectConversation, nudge: (id) => void nudgeUser(id) }),
  nudge: (userId) => void nudgeUser(userId),
  reply: (message) => {
    setReplyTo(message);
    messageInput.focus();
  },
  copy: (message) => void copyText(message.text ?? ''),
  forward: (message) => openForwardDialog([message.id], 'single', () => undefined),
  startSelect: (message) => {
    state.selecting = true;
    state.selected = new Set([message.id]);
    closePopovers();
    renderAll();
  },
  toggleSelect: (message) => {
    if (state.selected.has(message.id)) state.selected.delete(message.id);
    else if (state.selected.size >= 100) showToast('一次最多选 100 条');
    else state.selected.add(message.id);
    renderMessages();
    renderSelectBar();
  },
  recall: (message) => void recallMessage(message),
  jumpTo: (messageId) => void jumpTo(messageId),
  replayEffect,
});

// ---------- 多选和转发 ----------

function selectedMessages(): ChatMessage[] {
  return [...state.selected]
    .map((id) => state.messages.get(id))
    .filter((message): message is ChatMessage => Boolean(message))
    .sort((a, b) => a.at - b.at);
}

function renderSelectBar(): void {
  selectBar.hidden = !state.selecting;
  composer.hidden = state.selecting;
  if (!state.selecting) return;
  const count = state.selected.size;
  selectCount.textContent = `已选择 ${count} 条`;
  forwardMergeButton.disabled = count === 0;
  forwardSingleButton.disabled = count === 0;
}

function exitSelection(render = true): void {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  if (render) renderAll();
}

function forwardSelected(mode: 'merge' | 'single'): void {
  const messages = selectedMessages();
  if (messages.length === 0) return;
  if (mode === 'single' && !messages.every(isForwardable)) {
    showToast('投票、接龙、五子棋和已清理的文件不能逐条转发，可以用合并转发');
    return;
  }
  openForwardDialog(
    messages.map((message) => message.id),
    mode,
    () => exitSelection(),
  );
}

forwardMergeButton.addEventListener('click', () => forwardSelected('merge'));
forwardSingleButton.addEventListener('click', () => forwardSelected('single'));
byId('select-cancel').addEventListener('click', () => exitSelection());

// ---------- 输入栏的弹出菜单 ----------

const stickerPanel = createStickerPanel((sticker: StickerRef) => void sendContent({ sticker }));
const mentionPicker = createMentionPicker(messageInput, () => state.active === GROUP);
byId('composer-popovers').append(stickerPanel.element, mentionPicker.element);

function closePopovers(): void {
  stickerPanel.close();
  mentionPicker.close();
  closeMenu();
  moreMenu.hidden = true;
  effectMenu.hidden = true;
  stickerButton.setAttribute('aria-expanded', 'false');
  moreButton.setAttribute('aria-expanded', 'false');
  effectButton.setAttribute('aria-expanded', 'false');
}

function togglePopover(button: HTMLButtonElement, show: () => boolean): void {
  const wasOpen = button.getAttribute('aria-expanded') === 'true';
  closePopovers();
  if (!wasOpen) button.setAttribute('aria-expanded', String(show()));
}

stickerButton.addEventListener('click', () =>
  togglePopover(stickerButton, () => {
    stickerPanel.toggle();
    return true;
  }),
);

moreButton.addEventListener('click', () =>
  togglePopover(moreButton, () => {
    moreMenu.hidden = false;
    return true;
  }),
);

effectButton.addEventListener('click', () =>
  togglePopover(effectButton, () => {
    effectMenu.hidden = false;
    return true;
  }),
);

// 更多菜单：投票、接龙、大转盘、五子棋
const moreActions: [string, string, () => void][] = [
  ['📊', '投票', () => openPollDialog(state.active)],
  ['📝', '接龙', () => openRelayDialog(state.active)],
  ['🎡', '大转盘', () => openWheelDialog(state.active)],
  ['⚫', '五子棋', () => startGomoku(state.active)],
];
moreMenu.replaceChildren(
  ...moreActions.map(([icon, label, action]) =>
    h(
      'button',
      {
        className: 'menu-item',
        type: 'button',
        onclick: () => {
          closePopovers();
          action();
        },
      },
      h('span', { className: 'menu-icon', 'aria-hidden': 'true' }, icon),
      label,
    ),
  ),
);

// 特效菜单：选中后在输入框上方显示，下一条文字消息带上这个特效
function setPendingEffect(id: string | null): void {
  pendingEffect = id;
  const effect = effectInfo(id ?? undefined);
  effectChip.hidden = !effect;
  effectButton.classList.toggle('active', Boolean(effect));
  if (effect) {
    effectChip.replaceChildren(
      `✨ 下一条消息使用「${effect.name}」特效`,
      h('button', { className: 'chip-close', type: 'button', 'aria-label': '取消特效', onclick: () => setPendingEffect(null) }, '×'),
    );
  }
}

effectMenu.replaceChildren(
  ...(['bubble', 'screen'] as const).flatMap((kind) => [
    h('div', { className: 'menu-label' }, kind === 'bubble' ? '气泡特效' : '全屏特效'),
    ...EFFECTS.filter((effect) => effect.kind === kind).map((effect) =>
      h(
        'button',
        {
          className: 'menu-item',
          type: 'button',
          onclick: () => {
            closePopovers();
            setPendingEffect(effect.id);
            messageInput.focus();
          },
        },
        effect.name,
      ),
    ),
  ]),
);

document.addEventListener('click', (event) => {
  // 用事件路径判断，而不是 contains：点表情分类时面板会重画，被点的按钮已经不在页面上了
  const path = event.composedPath();
  const inside = [stickerPanel.element, moreMenu, effectMenu, stickerButton, moreButton, effectButton].some((el) => path.includes(el));
  if (!inside) {
    stickerPanel.close();
    moreMenu.hidden = true;
    effectMenu.hidden = true;
    stickerButton.setAttribute('aria-expanded', 'false');
    moreButton.setAttribute('aria-expanded', 'false');
    effectButton.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  closePopovers();
  if (state.selecting) exitSelection();
  else if (state.replyTo) setReplyTo(null);
});

// ---------- 发送 ----------

function resizeInput(): void {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight + 2}px`;
}

async function sendContent(input: api.MessageInput): Promise<void> {
  try {
    applyMessage(await api.sendMessage(state.active, input));
  } catch (error) {
    handleError(error);
  }
}

async function submitMessage(): Promise<void> {
  const text = messageInput.value.trim();
  if (!text || isSending) return;
  isSending = true;
  sendButton.disabled = true;
  const input: api.TextInput = { text };
  if (pendingEffect) input.effect = pendingEffect;
  if (state.replyTo) input.replyTo = state.replyTo.id;
  if (state.active === GROUP) {
    const mentions = collectMentions(text);
    if (mentions.length > 0) input.mentions = mentions;
  }
  try {
    applyMessage(await api.sendMessage(state.active, input));
    messageInput.value = '';
    drafts.delete(state.active);
    setPendingEffect(null);
    setReplyTo(null);
    resizeInput();
  } catch (error) {
    handleError(error);
  } finally {
    isSending = false;
    sendButton.disabled = false;
    messageInput.focus();
  }
}

// ---------- 发送文件：逐个排队上传 ----------

function enqueueFiles(files: Iterable<File>): void {
  let added = false;
  for (const file of files) {
    const tooLarge = file.size > state.limits.maxFileBytes;
    uploads.push({
      id: crypto.getRandomValues(new Uint32Array(2)).join('-'),
      file,
      to: state.active,
      status: tooLarge ? 'failed' : 'queued',
      progress: 0,
      error: tooLarge ? `超过 ${formatSize(state.limits.maxFileBytes)} 的大小限制，无法发送` : undefined,
      retryable: !tooLarge,
    });
    added = true;
  }
  if (!added) return;
  renderMessages({ forceBottom: true });
  void pumpUploads();
}

async function pumpUploads(): Promise<void> {
  if (uploads.some((upload) => upload.status === 'uploading')) return;
  const upload = uploads.find((item) => item.status === 'queued');
  if (!upload) return;

  upload.status = 'uploading';
  renderMessages();
  upload.handle = api.uploadFile(upload.file, upload.to, (ratio) => {
    upload.progress = ratio;
    updateUploadProgress(upload);
  });
  try {
    const message = await upload.handle.done;
    uploads = uploads.filter((item) => item !== upload);
    applyMessage(message);
  } catch (error) {
    if (error instanceof api.UploadCancelled) {
      uploads = uploads.filter((item) => item !== upload);
    } else if (error instanceof api.ApiError && error.status === 401) {
      showLogin();
      return;
    } else {
      upload.status = 'failed';
      upload.error = messageOf(error);
    }
    renderMessages();
  }
  void pumpUploads();
}

function retryUpload(upload: Upload): void {
  upload.status = 'queued';
  upload.progress = 0;
  upload.error = undefined;
  renderMessages();
  void pumpUploads();
}

function removeUpload(upload: Upload): void {
  // 上传中的文件走取消流程，由 pumpUploads 负责移除并继续下一个
  if (upload.status === 'uploading') {
    upload.handle?.cancel();
    return;
  }
  uploads = uploads.filter((item) => item !== upload);
  renderMessages();
}

// ---------- 粘贴截图和文件 ----------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 截图粘贴进来时浏览器统一叫 image.png，换成带时间的名字，免得一堆同名文件 */
function namePastedFile(file: File): File {
  if (!/^image\.\w+$/.test(file.name)) return file;
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension = file.name.split('.').pop();
  return new File([file], `截图-${stamp}.${extension}`, { type: file.type });
}

/** 粘贴的文件先预览确认再发，避免误粘贴。按回车直接发送 */
function confirmSendFiles(files: File[]): void {
  const urls: string[] = [];
  const items = files.map((file) => {
    if (file.type.startsWith('image/') && file.size <= state.limits.maxFileBytes) {
      const url = URL.createObjectURL(file);
      urls.push(url);
      return h('figure', { className: 'paste-image' }, h('img', { src: url, alt: '' }), h('figcaption', {}, `${file.name} · ${formatSize(file.size)}`));
    }
    return h(
      'div',
      { className: 'file-row paste-file' },
      h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(file.name)),
      h('div', { className: 'file-info' }, h('div', { className: 'file-name' }, file.name), h('div', { className: 'file-detail' }, formatSize(file.size))),
    );
  });
  const target = state.active;
  const sendButtonEl = h(
    'button',
    {
      className: 'btn btn-primary',
      type: 'button',
      onclick: () => {
        dialog.close();
        if (state.active !== target) selectConversation(target);
        enqueueFiles(files);
      },
    },
    '发送',
  );
  const dialog = openDialog(
    'paste-dialog',
    h('h2', {}, `发送给${conversationName(target)}`),
    h('div', { className: 'paste-list' }, ...items),
    h(
      'div',
      { className: 'dialog-actions' },
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'),
      sendButtonEl,
    ),
  );
  dialog.addEventListener('close', () => {
    urls.forEach((url) => URL.revokeObjectURL(url));
    messageInput.focus();
  });
  sendButtonEl.focus();
}

document.addEventListener('paste', (event) => {
  if (workspaceView.hidden || state.selecting || document.querySelector('dialog[open]')) return;
  const data = event.clipboardData;
  const files = [...(data?.files ?? [])];
  // 复制的是文字（比如从 Word 复制一段，里面会同时带一张图片）时，照常粘贴文字
  if (files.length === 0 || data?.getData('text/plain').trim()) return;
  event.preventDefault();
  confirmSendFiles(files.map(namePastedFile));
});

// ---------- 拖拽文件 ----------

let dragDepth = 0;

function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

function hideDropOverlay(): void {
  dragDepth = 0;
  dropOverlay.hidden = true;
}

window.addEventListener('dragenter', (event) => {
  if (workspaceView.hidden || !isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropText.textContent = `松开发送给${conversationName(state.active)}`;
  dropOverlay.hidden = false;
});

window.addEventListener('dragover', (event) => {
  // 不阻止默认行为的话，浏览器会直接打开拖进来的文件
  if (isFileDrag(event)) event.preventDefault();
});

window.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth -= 1;
  if (dragDepth <= 0) hideDropOverlay();
});

window.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  hideDropOverlay();
  // 弹窗打开时（比如在选聊天背景）不处理，避免误发
  if (workspaceView.hidden || !event.dataTransfer || document.querySelector('dialog[open]')) return;

  const files: File[] = [];
  let hasFolder = false;
  for (const item of event.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry()?.isDirectory) {
      hasFolder = true;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (hasFolder) showToast('暂不支持发送文件夹，请先压缩成一个文件');
  if (state.selecting) exitSelection();
  enqueueFiles(files);
});

// ---------- 服务器推送 ----------

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'users':
      state.users = event.users;
      state.me = state.users.find((user) => user.id === state.me?.id) ?? state.me;
      renderSidebar();
      renderChatHead();
      // 只有头像、昵称、气泡变了才重画消息，单纯的上下线不重画，免得打断正在选中的文字
      if (userLook() !== lastUserLook) renderMessages();
      return;
    case 'deleted':
      removeMessage(event.id);
      return;
    case 'stickers':
      state.stickers = event.stickers;
      stickerPanel.refresh();
      renderMessages();
      return;
    case 'storage':
      state.storage = event.storage;
      renderStorage();
      renderChatHead();
      maybeAlertStorage();
      return;
    case 'remarks':
      state.remarks = event.remarks;
      renderAll();
      return;
    default:
      applyMessage(event.message);
  }
}

/**
 * 把服务器返回的数据合并进来。用合并而不是替换，避免覆盖刚通过推送收到的消息、丢掉已经往上翻出来的历史。
 * 服务器给出的范围里却没有的消息，是断线期间被撤回的，要删掉。
 */
function applySession(session: SessionInfo): void {
  state.me = session.me;
  state.users = session.users;
  state.stickers = session.stickers;
  state.limits = session.limits;
  state.remarks = session.remarks;
  state.storage = session.storage;
  state.admin = session.admin;

  const fresh = new Set(session.messages.map((message) => message.id));
  const oldestAt = new Map<string, number>();
  for (const message of session.messages) {
    const conversation = conversationOf(message);
    oldestAt.set(conversation, Math.min(oldestAt.get(conversation) ?? Infinity, message.at));
  }
  const serverOlder = new Set(session.older);
  const older = new Set<string>();
  for (const conversation of serverOlder) {
    // 已经往上翻过、而且翻到头了的会话，不用再显示“查看更早的消息”
    const pagedBefore = [...state.messages.values()].some(
      (message) => conversationOf(message) === conversation && message.at < (oldestAt.get(conversation) ?? 0),
    );
    if (!pagedBefore || state.older.has(conversation)) older.add(conversation);
  }
  for (const message of state.messages.values()) {
    if (fresh.has(message.id)) continue;
    const conversation = conversationOf(message);
    if (!serverOlder.has(conversation) || message.at >= (oldestAt.get(conversation) ?? Infinity)) {
      state.messages.delete(message.id);
    }
  }
  state.older = older;
  for (const message of session.messages) state.messages.set(message.id, message);

  if (readMarks.firstSeen === undefined) {
    readMarks.firstSeen = session.messages.reduce((latest, message) => Math.max(latest, message.at), 0);
    writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  }
  if (state.active !== GROUP && !userById(state.active)) state.active = GROUP;
}

/** 重新拉取数据。连接刚建立或断线重连后调用，补上断线期间错过的内容 */
async function resync(): Promise<void> {
  try {
    applySession(await api.fetchSession());
    renderAll();
    maybeAlertStorage();
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) showLogin();
  }
}

function connectEvents(): void {
  events?.close();
  const source = new EventSource('/api/events');
  events = source;
  source.onopen = () => {
    banner.hidden = true;
    void resync();
  };
  source.onmessage = (event: MessageEvent<string>) => {
    handleServerEvent(JSON.parse(event.data) as ServerEvent);
  };
  source.onerror = () => {
    banner.hidden = false;
    // CONNECTING 时浏览器会自动重连；CLOSED 表示它放弃了（比如登录失效），要自己处理
    if (source.readyState !== EventSource.CLOSED) return;
    void resync().then(() => {
      if (events === source && !workspaceView.hidden) window.setTimeout(connectEvents, 3000);
    });
  };
}

// ---------- 登录和退出 ----------

function showLogin(): void {
  events?.close();
  events = null;
  state.me = null;
  state.users = [];
  state.messages.clear();
  state.older.clear();
  state.remarks = {};
  drafts.clear();
  uploads.forEach((upload) => upload.handle?.cancel());
  uploads = [];
  state.active = GROUP;
  exitSelection(false);
  setReplyTo(null);
  closePopovers();
  document.querySelectorAll('dialog[open]').forEach((dialog) => (dialog as HTMLDialogElement).close());
  workspaceView.hidden = true;
  loginView.hidden = false;
  document.title = APP_TITLE;
  loginName.focus();
}

function showWorkspace(session: SessionInfo): void {
  applySession(session);
  loginView.hidden = true;
  workspaceView.hidden = false;
  loginCode.value = '';
  renderAll({ forceBottom: true });
  connectEvents();
  messageInput.focus();
  maybeAlertStorage();
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 服务器连不上时也回到登录页
  }
  // 退出后清掉已读记录，下一位登录的人从自己的视角重新开始
  readMarks = { conversations: {} };
  writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  showLogin();
}

onRender(() => {
  if (!workspaceView.hidden) renderAll();
});
onUnauthorized(showLogin);

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  loginSubmit.disabled = true;
  try {
    await api.login(loginName.value, loginCode.value);
    showWorkspace(await api.fetchSession());
  } catch (error) {
    loginError.textContent = messageOf(error);
    loginError.hidden = false;
  } finally {
    loginSubmit.disabled = false;
  }
});

profileButton.addEventListener('click', () => openMyProfile(() => void logout()));
chatTitle.addEventListener('click', () => {
  if (state.active !== GROUP) openUserCard(state.active, { message: selectConversation, nudge: (id) => void nudgeUser(id) });
});
searchButton.addEventListener('click', () => openSearchDialog((hit) => void jumpTo(hit.message.id, hit.conversation)));
storageMeter.addEventListener('click', openStorageDialog);

// ---------- 输入框 ----------

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitMessage();
});

messageInput.addEventListener('input', resizeInput);

messageInput.addEventListener('keydown', (event) => {
  // @ 列表打开时，上下键和回车用来选人
  if (mentionPicker.handleKeydown(event)) return;
  // isComposing：中文输入法选字时按 Enter 是确认候选词，不能发送
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitMessage();
  }
});

fileInput.addEventListener('change', () => {
  enqueueFiles(fileInput.files ?? []);
  // 清空后，下次选同一个文件也能触发 change
  fileInput.value = '';
});

// ---------- 未加密连接的提示 ----------

function openInsecureInfo(): void {
  const dialog = openDialog(
    'dialog-small',
    h('h2', {}, '当前连接没有加密'),
    h(
      'p',
      { className: 'dialog-text' },
      '你现在用的是备用地址（http://），聊天内容和文件在网络上是明文传输的。功能和加密地址完全一样。',
    ),
    h(
      'p',
      { className: 'dialog-text' },
      '如果你的浏览器能打开加密地址，建议改用它。第一次打开会提示“不安全”，点“高级 → 继续访问”即可。打不开的话继续用现在的地址也没关系。',
    ),
    h(
      'div',
      { className: 'dialog-actions' },
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '继续用现在的地址'),
      h('a', { className: 'btn btn-primary', href: secureUrl }, '改用加密地址'),
    ),
  );
}

async function showInsecureHints(): Promise<void> {
  if (!insecure) return;
  try {
    if (!(await api.fetchInfo()).https) return;
  } catch {
    return;
  }
  insecureBadge.hidden = false;
  loginInsecure.hidden = false;
  loginInsecure.replaceChildren(
    '当前连接没有加密。能打开的话建议改用 ',
    h('a', { href: secureUrl }, '加密地址'),
    '。',
  );
}

insecureBadge.addEventListener('click', openInsecureInfo);

// ---------- 其他 ----------

document.addEventListener('visibilitychange', () => {
  if (!workspaceView.hidden) renderAll();
});

function applyTheme(theme: string | null): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

byId('theme-toggle').addEventListener('click', () => {
  const current =
    document.documentElement.dataset.theme ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  writeStorage(THEME_KEY, next);
});

// 防止上传中途误关页面
window.addEventListener('beforeunload', (event) => {
  if (uploads.some((upload) => upload.status === 'uploading' || upload.status === 'queued')) event.preventDefault();
});

// ---------- 启动 ----------

async function start(): Promise<void> {
  applyTheme(readStorage(THEME_KEY));
  void applyChatBackground();
  void showInsecureHints();
  try {
    showWorkspace(await api.fetchSession());
  } catch (error) {
    showLogin();
    if (!(error instanceof api.ApiError && error.status === 401)) {
      loginError.textContent = messageOf(error);
      loginError.hidden = false;
    }
  }
}

void start();
