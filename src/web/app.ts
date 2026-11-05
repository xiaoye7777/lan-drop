// 页面主逻辑。结构是“状态 + 渲染函数”：状态变了就调用对应的 render 函数重画那一块。
import type { ChatMessage, GroupRecipient, Recipient, ServerEvent, SessionInfo, UserInfo } from '../shared/types.js';
import * as api from './api.js';
import { dayKey, fileExtension, formatDay, formatExpiry, formatSize, formatTime } from './format.js';

const GROUP: GroupRecipient = 'all';
const APP_TITLE = '内网快传';
const READ_MARKS_KEY = 'lan-drop-read-marks';
const THEME_KEY = 'lan-drop-theme';
/** 距离底部小于这个值时，新消息到来会自动滚到底 */
const STICK_TO_BOTTOM_PX = 80;

// ---------- 页面元素 ----------

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const loginView = byId('login-view');
const loginForm = byId<HTMLFormElement>('login-form');
const loginName = byId<HTMLInputElement>('login-name');
const loginCode = byId<HTMLInputElement>('login-code');
const loginError = byId('login-error');
const loginSubmit = byId<HTMLButtonElement>('login-submit');
const workspaceView = byId('workspace-view');
const conversationsEl = byId('conversations');
const profileButton = byId<HTMLButtonElement>('profile-button');
const chatTitle = byId('chat-title');
const chatSubtitle = byId('chat-subtitle');
const banner = byId('connection-banner');
const messagesEl = byId('messages');
const composer = byId<HTMLFormElement>('composer');
const fileInput = byId<HTMLInputElement>('file-input');
const messageInput = byId<HTMLTextAreaElement>('message-input');
const sendButton = byId<HTMLButtonElement>('send-button');
const dropOverlay = byId('drop-overlay');
const dropText = byId('drop-text');
const profileDialog = byId<HTMLDialogElement>('profile-dialog');
const profileForm = byId<HTMLFormElement>('profile-form');
const profileName = byId<HTMLInputElement>('profile-name');
const profileError = byId('profile-error');
const toastEl = byId('toast');

// ---------- 状态 ----------

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
  handle?: api.UploadHandle;
}

let me: UserInfo | null = null;
let users: UserInfo[] = [];
let maxFileBytes = 0;
let activeConversation: Recipient = GROUP;
let uploads: Upload[] = [];
let events: EventSource | null = null;
let isSending = false;
const messages = new Map<string, ChatMessage>();

// ---------- 浏览器本地存储（失败也不影响使用） ----------

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等情况下可能写不进去，忽略
  }
}

// ---------- 小工具 ----------

type Child = Node | string | null | undefined | false;

/** 创建 DOM 元素。内容都通过 textContent 写入，消息里的 HTML 不会被执行 */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-') || key.startsWith('data-')) el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

let toastTimer: number | undefined;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

/** 登录状态失效时回到登录页。返回 true 表示已处理 */
function handleUnauthorized(error: unknown): boolean {
  if (error instanceof api.ApiError && error.status === 401) {
    showLogin();
    return true;
  }
  return false;
}

// ---------- 会话和未读 ----------

/** 一条消息属于哪个会话：全组，或私聊的对方 */
function conversationOf(message: ChatMessage): Recipient {
  if (message.to === GROUP) return GROUP;
  return message.from === me?.id ? message.to : message.from;
}

function conversationMessages(conversation: Recipient): ChatMessage[] {
  return [...messages.values()]
    .filter((message) => conversationOf(message) === conversation)
    .sort((a, b) => a.at - b.at);
}

function userById(id: string): UserInfo | undefined {
  return users.find((user) => user.id === id);
}

function conversationName(conversation: Recipient): string {
  if (conversation === GROUP) return '全组';
  return userById(conversation)?.name ?? '已离开的同事';
}

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
  if (message.from === me?.id) return false;
  const mark = readMarks.conversations[conversationOf(message)] ?? readMarks.firstSeen ?? 0;
  return message.at > mark;
}

function unreadCount(conversation: Recipient): number {
  return conversationMessages(conversation).filter(isUnread).length;
}

/** 当前会话正在被看时，把它标记为已读 */
function markActiveAsRead(): void {
  if (document.visibilityState !== 'visible') return;
  const latest = conversationMessages(activeConversation).at(-1);
  if (latest && latest.at > (readMarks.conversations[activeConversation] ?? 0)) {
    readMarks.conversations[activeConversation] = latest.at;
    writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  }
}

// 页面在后台且有未读时让标题闪烁。HTTP 页面用不了系统通知，这是最醒目的提醒方式
let titleFlashOn = false;

function updateTitle(): void {
  const total = [...messages.values()].filter(isUnread).length;
  if (total === 0) {
    document.title = APP_TITLE;
    return;
  }
  const flash = document.visibilityState === 'hidden' && titleFlashOn;
  document.title = flash ? '【新消息】' : `(${total}) ${APP_TITLE}`;
}

window.setInterval(() => {
  titleFlashOn = !titleFlashOn;
  updateTitle();
}, 1000);

// ---------- 渲染：侧边栏 ----------

function renderAvatar(name: string, online: boolean): HTMLElement {
  return h(
    'span',
    { className: online ? 'avatar' : 'avatar avatar-offline', 'aria-hidden': 'true' },
    [...name][0] ?? '?',
    online && h('span', { className: 'status-dot' }),
  );
}

function renderConversationButton(id: Recipient, name: string, meta: string, avatar: HTMLElement): HTMLElement {
  const unread = id === activeConversation ? 0 : unreadCount(id);
  return h(
    'button',
    {
      className: 'conversation',
      type: 'button',
      'aria-current': String(id === activeConversation),
      onclick: () => selectConversation(id),
    },
    avatar,
    h(
      'span',
      { className: 'conversation-text' },
      h('span', { className: 'conversation-name' }, name),
      h('span', { className: 'conversation-meta' }, meta),
    ),
    unread > 0 && h('span', { className: 'unread-badge', 'aria-label': `${unread} 条未读` }, String(unread)),
  );
}

function renderSidebar(): void {
  const others = users
    .filter((user) => user.id !== me?.id)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh'));
  const onlineCount = users.filter((user) => user.online).length;

  const nodes: Node[] = [
    renderConversationButton(GROUP, '全组', `${onlineCount} 人在线`, renderAvatar('全', true)),
    h('div', { className: 'section-label' }, '同事'),
    ...others.map((user) =>
      renderConversationButton(
        user.id,
        user.name,
        `${user.online ? '在线' : '离线'} · ${user.ip}`,
        renderAvatar(user.name, user.online),
      ),
    ),
  ];
  if (others.length === 0) nodes.push(h('div', { className: 'empty-hint' }, '同事登录后会显示在这里'));
  conversationsEl.replaceChildren(...nodes);

  if (me) {
    profileButton.replaceChildren(
      renderAvatar(me.name, true),
      h(
        'span',
        { className: 'conversation-text' },
        h('span', { className: 'conversation-name' }, me.name),
        h('span', { className: 'conversation-meta' }, '修改昵称 / 退出'),
      ),
    );
  }
}

// ---------- 渲染：聊天区 ----------

function renderChatHead(): void {
  const user = userById(activeConversation);
  chatTitle.textContent = conversationName(activeConversation);
  if (activeConversation === GROUP) {
    chatSubtitle.textContent = `共 ${users.length} 人，${users.filter((item) => item.online).length} 人在线`;
  } else if (user) {
    chatSubtitle.textContent = user.online ? `在线 · ${user.ip}` : `离线 · ${user.ip} · 对方上线后可以收到消息和文件`;
  } else {
    chatSubtitle.textContent = '';
  }
  messageInput.placeholder = `发消息给${conversationName(activeConversation)}（Enter 发送）`;
}

function renderFileCard(message: ChatMessage): HTMLElement {
  const file = message.file!;
  const expired = file.expiresAt <= Date.now();
  return h(
    'div',
    { className: expired ? 'file-card file-expired' : 'file-card' },
    h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(file.name)),
    h(
      'div',
      { className: 'file-info' },
      h('div', { className: 'file-name', title: file.name }, file.name),
      h(
        'div',
        { className: 'file-detail' },
        `${formatSize(file.size)} · ${expired ? '已过期' : formatExpiry(file.expiresAt)}`,
      ),
    ),
    !expired &&
      h(
        'a',
        {
          className: 'btn btn-ghost btn-small',
          href: `/api/files/${file.id}`,
          download: file.name,
          'aria-label': `下载 ${file.name}`,
        },
        '下载',
      ),
  );
}

function renderMessage(message: ChatMessage): HTMLElement {
  const mine = message.from === me?.id;
  const meta = mine ? formatTime(message.at) : `${message.fromName} · ${formatTime(message.at)}`;
  return h(
    'div',
    { className: mine ? 'message message-mine' : 'message' },
    h('div', { className: 'message-meta' }, meta),
    message.file ? renderFileCard(message) : h('div', { className: 'bubble' }, message.text ?? ''),
  );
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
      { className: 'file-card' },
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
        h(
          'button',
          { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => removeUpload(upload) },
          failed ? '移除' : '取消',
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

function renderMessages(forceBottom = false): void {
  const distanceToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  const stick = forceBottom || distanceToBottom < STICK_TO_BOTTOM_PX;

  const list = conversationMessages(activeConversation);
  const activeUploads = uploads.filter((upload) => upload.to === activeConversation);
  const nodes: Node[] = [];

  if (list.length === 0 && activeUploads.length === 0) {
    nodes.push(h('div', { className: 'empty-chat' }, '还没有消息。可以直接输入文字，或把文件拖到这里发送。'));
  }
  let lastDay = '';
  for (const message of list) {
    const key = dayKey(message.at);
    if (key !== lastDay) {
      nodes.push(h('div', { className: 'day-divider' }, formatDay(message.at)));
      lastDay = key;
    }
    nodes.push(renderMessage(message));
  }
  nodes.push(...activeUploads.map(renderUpload));
  messagesEl.replaceChildren(...nodes);
  activeUploads.filter((upload) => upload.status === 'uploading').forEach(updateUploadProgress);

  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAll(forceBottom = false): void {
  markActiveAsRead();
  renderSidebar();
  renderChatHead();
  renderMessages(forceBottom);
  updateTitle();
}

function selectConversation(conversation: Recipient): void {
  activeConversation = conversation;
  renderAll(true);
  messageInput.focus();
}

// ---------- 发送文字 ----------

function resizeInput(): void {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight + 2}px`;
}

async function submitMessage(): Promise<void> {
  const text = messageInput.value.trim();
  if (!text || isSending) return;
  isSending = true;
  sendButton.disabled = true;
  try {
    addMessage(await api.sendText(activeConversation, text));
    messageInput.value = '';
    resizeInput();
    renderAll(true);
  } catch (error) {
    if (!handleUnauthorized(error)) showToast(messageOf(error));
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
    const tooLarge = file.size > maxFileBytes;
    uploads.push({
      id: crypto.getRandomValues(new Uint32Array(2)).join('-'),
      file,
      to: activeConversation,
      status: tooLarge ? 'failed' : 'queued',
      progress: 0,
      error: tooLarge ? `超过 ${formatSize(maxFileBytes)} 的大小限制，无法发送` : undefined,
      retryable: !tooLarge,
    });
    added = true;
  }
  if (!added) return;
  renderMessages(true);
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
    addMessage(message);
    renderAll(upload.to === activeConversation);
  } catch (error) {
    if (error instanceof api.UploadCancelled) {
      uploads = uploads.filter((item) => item !== upload);
    } else if (handleUnauthorized(error)) {
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
  dropText.textContent = `松开发送给${conversationName(activeConversation)}`;
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
  if (workspaceView.hidden || !event.dataTransfer) return;

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
  enqueueFiles(files);
});

// ---------- 服务器推送 ----------

function addMessage(message: ChatMessage): void {
  messages.set(message.id, message);
}

function handleServerEvent(event: ServerEvent): void {
  if (event.type === 'users') {
    users = event.users;
    me = users.find((user) => user.id === me?.id) ?? me;
    renderSidebar();
    renderChatHead();
    return;
  }
  addMessage(event.message);
  renderAll();
}

/** 把服务器返回的完整数据合并进来。用合并而不是替换，避免覆盖刚通过推送收到的消息 */
function applySession(session: SessionInfo): void {
  me = session.me;
  users = session.users;
  maxFileBytes = session.maxFileBytes;
  for (const message of session.messages) addMessage(message);
  if (readMarks.firstSeen === undefined) {
    readMarks.firstSeen = session.messages.reduce((latest, message) => Math.max(latest, message.at), 0);
    writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  }
  if (activeConversation !== GROUP && !userById(activeConversation)) activeConversation = GROUP;
}

/** 重新拉取数据。连接刚建立或断线重连后调用，补上断线期间错过的内容 */
async function resync(): Promise<void> {
  try {
    applySession(await api.fetchSession());
    renderAll();
  } catch (error) {
    handleUnauthorized(error);
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
  me = null;
  users = [];
  messages.clear();
  uploads.forEach((upload) => upload.handle?.cancel());
  uploads = [];
  activeConversation = GROUP;
  if (profileDialog.open) profileDialog.close();
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
  renderAll(true);
  connectEvents();
  messageInput.focus();
}

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

// ---------- 个人设置 ----------

profileButton.addEventListener('click', () => {
  profileName.value = me?.name ?? '';
  profileError.hidden = true;
  profileDialog.showModal();
  profileName.select();
});

byId('profile-cancel').addEventListener('click', () => profileDialog.close());

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileError.hidden = true;
  try {
    await api.rename(profileName.value);
    profileDialog.close();
    await resync();
  } catch (error) {
    if (handleUnauthorized(error)) return;
    profileError.textContent = messageOf(error);
    profileError.hidden = false;
  }
});

byId('logout-button').addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    // 服务器连不上时也回到登录页
  }
  // 退出后清掉已读记录的归属，下一位登录的人从自己的视角重新开始
  readMarks = { conversations: {} };
  writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
  showLogin();
});

// ---------- 输入框 ----------

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitMessage();
});

messageInput.addEventListener('input', resizeInput);

messageInput.addEventListener('keydown', (event) => {
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

// ---------- 其他 ----------

document.addEventListener('visibilitychange', () => {
  if (!workspaceView.hidden) renderAll();
});

// 文件到期时刷新一次，让下载按钮变成“已过期”
let lastExpiryCheck = Date.now();
window.setInterval(() => {
  const now = Date.now();
  const crossed = [...messages.values()].some(
    ({ file }) => file && file.expiresAt > lastExpiryCheck && file.expiresAt <= now,
  );
  lastExpiryCheck = now;
  if (crossed && !workspaceView.hidden) renderMessages();
}, 30_000);

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
