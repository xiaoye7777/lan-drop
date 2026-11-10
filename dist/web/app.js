import { EFFECTS } from '../shared/catalog.js';
import { openPollDialog, openRelayDialog, openWheelDialog, renderGomoku, renderPoll, renderRelay, renderWheel, startGomoku, } from './activities.js';
import * as api from './api.js';
import { applyChatBackground } from './chat-background.js';
import { bubbleClass, nameplateClass, renderAvatar } from './components.js';
import { byId, confirmAction, h, messageOf, readStorage, showToast, writeStorage } from './dom.js';
import { BUBBLE_EFFECT_MS, effectInfo, playScreenEffect } from './effects.js';
import { dayKey, fileExtension, formatDay, formatExpiry, formatSize, formatTime } from './format.js';
import { openImagePreview } from './preview.js';
import { openMyProfile, openUserCard } from './profile.js';
import { animationElapsed, applyMessage, conversationMessages, conversationName, conversationOf, GROUP, handleError, onRender, onUnauthorized, state, userById, } from './state.js';
import { createStickerPanel, renderSticker, STICKER_PLAY_MS } from './stickers.js';
const APP_TITLE = '内网快传';
const READ_MARKS_KEY = 'lan-drop-read-marks';
const THEME_KEY = 'lan-drop-theme';
/** 距离底部小于这个值时，新消息到来会自动滚到底 */
const STICK_TO_BOTTOM_PX = 80;
// ---------- 页面元素 ----------
const loginView = byId('login-view');
const loginForm = byId('login-form');
const loginName = byId('login-name');
const loginCode = byId('login-code');
const loginError = byId('login-error');
const loginSubmit = byId('login-submit');
const workspaceView = byId('workspace-view');
const conversationsEl = byId('conversations');
const profileButton = byId('profile-button');
const chatTitle = byId('chat-title');
const chatSubtitle = byId('chat-subtitle');
const banner = byId('connection-banner');
const messagesEl = byId('messages');
const composer = byId('composer');
const fileInput = byId('file-input');
const messageInput = byId('message-input');
const sendButton = byId('send-button');
const stickerButton = byId('sticker-button');
const moreButton = byId('more-button');
const moreMenu = byId('more-menu');
const effectButton = byId('effect-button');
const effectMenu = byId('effect-menu');
const effectChip = byId('effect-chip');
const dropOverlay = byId('drop-overlay');
const dropText = byId('drop-text');
let uploads = [];
let events = null;
let isSending = false;
/** 选好、还没发出去的消息特效 */
let pendingEffect = null;
/** 上次画消息列表时同事们的头像、昵称、气泡，变了才需要重画消息 */
let lastUserLook = '';
function loadReadMarks() {
    try {
        const parsed = JSON.parse(readStorage(READ_MARKS_KEY) ?? '');
        if (parsed && typeof parsed.conversations === 'object')
            return parsed;
    }
    catch {
        // 没有记录或记录损坏，从头开始
    }
    return { conversations: {} };
}
let readMarks = loadReadMarks();
function isUnread(message) {
    if (message.from === state.me?.id)
        return false;
    const mark = readMarks.conversations[conversationOf(message)] ?? readMarks.firstSeen ?? 0;
    return message.at > mark;
}
function unreadCount(conversation) {
    return conversationMessages(conversation).filter(isUnread).length;
}
/** 当前会话正在被看时，把它标记为已读 */
function markActiveAsRead() {
    if (document.visibilityState !== 'visible')
        return;
    const latest = conversationMessages(state.active).at(-1);
    if (latest && latest.at > (readMarks.conversations[state.active] ?? 0)) {
        readMarks.conversations[state.active] = latest.at;
        writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
    }
}
// 页面在后台且有未读时让标题闪烁
let titleFlashOn = false;
function updateTitle() {
    const total = [...state.messages.values()].filter(isUnread).length;
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
function renderConversationButton(id, name, meta, avatar, nameplate) {
    const unread = id === state.active ? 0 : unreadCount(id);
    return h('button', {
        className: `conversation ${nameplateClass(nameplate)}`,
        type: 'button',
        'aria-current': String(id === state.active),
        onclick: () => selectConversation(id),
    }, avatar, h('span', { className: 'conversation-text' }, h('span', { className: 'conversation-name' }, name), h('span', { className: 'conversation-meta' }, meta)), unread > 0 && h('span', { className: 'unread-badge', 'aria-label': `${unread} 条未读` }, String(unread)));
}
function renderSidebar() {
    const others = state.users
        .filter((user) => user.id !== state.me?.id)
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh'));
    const onlineCount = state.users.filter((user) => user.online).length;
    const groupAvatar = h('span', { className: 'avatar avatar-md avatar-group', 'aria-hidden': 'true' }, '全');
    const nodes = [
        renderConversationButton(GROUP, '全组', `${onlineCount} 人在线`, groupAvatar),
        h('div', { className: 'section-label' }, '同事'),
        ...others.map((user) => renderConversationButton(user.id, user.name, user.bio || `${user.online ? '在线' : '离线'} · ${user.ip}`, renderAvatar(user, 'md', user.online), user.nameplate)),
    ];
    if (others.length === 0)
        nodes.push(h('div', { className: 'empty-hint' }, '同事登录后会显示在这里'));
    conversationsEl.replaceChildren(...nodes);
    const me = state.me;
    if (me) {
        profileButton.className = `profile-button ${nameplateClass(me.nameplate)}`;
        profileButton.replaceChildren(renderAvatar(me, 'md', true), h('span', { className: 'conversation-text' }, h('span', { className: 'conversation-name' }, me.name), h('span', { className: 'conversation-meta' }, '个人主页')));
    }
}
// ---------- 渲染：聊天区 ----------
function renderChatHead() {
    const user = userById(state.active);
    chatTitle.textContent = conversationName(state.active);
    chatTitle.disabled = !user;
    if (state.active === GROUP) {
        chatSubtitle.textContent = `共 ${state.users.length} 人，${state.users.filter((item) => item.online).length} 人在线`;
    }
    else if (user) {
        const status = user.online ? '在线' : '离线，上线后能收到';
        chatSubtitle.textContent = [status, user.ip, user.bio].filter(Boolean).join(' · ');
    }
    else {
        chatSubtitle.textContent = '';
    }
    messageInput.placeholder = `发消息给${conversationName(state.active)}（Enter 发送）`;
}
function renderFileCard(message) {
    const file = message.file;
    const expired = file.expiresAt <= Date.now();
    const preview = file.image && !expired
        ? h('button', { className: 'file-thumb', type: 'button', 'aria-label': `查看大图 ${file.name}`, onclick: () => openImagePreview(file) }, h('img', { src: `/api/files/${file.id}/preview`, alt: '', loading: 'lazy', decoding: 'async' }))
        : null;
    return h('div', { className: `file-card${expired ? ' file-expired' : ''}${preview ? ' has-thumb' : ''}` }, preview, h('div', { className: 'file-row' }, h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(file.name)), h('div', { className: 'file-info' }, h('div', { className: 'file-name', title: file.name }, file.name), h('div', { className: 'file-detail' }, `${formatSize(file.size)} · ${expired ? '已过期' : formatExpiry(file.expiresAt)}`)), !expired &&
        h('a', { className: 'btn btn-ghost btn-small', href: `/api/files/${file.id}`, download: file.name, 'aria-label': `下载 ${file.name}` }, '下载')));
}
/** 文字气泡：样式用发送者选的气泡，再叠加消息特效 */
function renderTextBubble(message, sender) {
    const bubble = h('div', { className: bubbleClass(sender?.bubble) }, h('span', { className: 'bubble-text' }, message.text ?? ''));
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
    }
    else if (effect?.kind === 'bubble' && BUBBLE_EFFECT_MS[effect.id]) {
        const elapsed = animationElapsed(message.id, BUBBLE_EFFECT_MS[effect.id]);
        if (elapsed !== null) {
            // 负的延迟：重画时从已经播放到的位置接着播
            bubble.classList.add(`fx-${effect.id}`);
            bubble.style.animationDelay = `-${elapsed}ms`;
        }
    }
    return bubble;
}
function replayEffect(message) {
    state.revealedInk.delete(message.id);
    state.animations.set(message.id, performance.now());
    if (message.effect)
        playScreenEffect(message.effect);
    renderMessages();
}
function renderContent(message, sender) {
    if (message.file)
        return renderFileCard(message);
    if (message.sticker)
        return renderSticker(message.sticker, animationElapsed(message.id, STICKER_PLAY_MS) !== null);
    if (message.poll)
        return renderPoll(message);
    if (message.relay)
        return renderRelay(message);
    if (message.wheel)
        return renderWheel(message);
    if (message.gomoku)
        return renderGomoku(message);
    return renderTextBubble(message, sender);
}
/** 撤回自己的消息：确认后服务器永久删除，所有人那边同时消失 */
async function recallMessage(message) {
    const ok = await confirmAction('撤回这条消息？', message.file
        ? '撤回后所有人都看不到，服务器上的文件也会一起删除，无法恢复。已经下载过的人手里的文件删不掉。'
        : '撤回后所有人都看不到，服务器上会永久删除，无法恢复。', '撤回');
    if (!ok)
        return;
    try {
        await api.recall(message.id);
        removeMessage(message.id);
    }
    catch (error) {
        handleError(error);
    }
}
function removeMessage(id) {
    state.messages.delete(id);
    state.animations.delete(id);
    state.revealedInk.delete(id);
    renderAll();
}
function renderMessage(message) {
    const mine = message.from === state.me?.id;
    const sender = userById(message.from);
    const effect = effectInfo(message.effect);
    const author = sender ?? { id: message.from, name: message.fromName, avatar: null };
    return h('div', { className: mine ? 'message message-mine' : 'message' }, h('button', {
        className: 'message-avatar',
        type: 'button',
        'aria-label': `查看 ${author.name} 的资料`,
        disabled: !sender,
        onclick: () => openUserCard(message.from, selectConversation),
    }, renderAvatar(author, 'sm')), h('div', { className: 'message-body' }, h('div', { className: 'message-meta' }, mine ? formatTime(message.at) : `${message.fromName} · ${formatTime(message.at)}`, mine && h('button', { className: 'recall-btn', type: 'button', onclick: () => void recallMessage(message) }, '撤回')), renderContent(message, sender), effect &&
        h('button', { className: 'effect-tag', type: 'button', title: '重播特效', onclick: () => replayEffect(message) }, `✨ ${effect.name} · 重播`)));
}
function renderUpload(upload) {
    const failed = upload.status === 'failed';
    const detail = failed
        ? upload.error
        : upload.status === 'queued'
            ? `${formatSize(upload.file.size)} · 等待发送`
            : `${formatSize(upload.file.size)} · ${Math.round(upload.progress * 100)}%`;
    return h('div', { className: 'message message-mine', 'data-upload': upload.id }, h('div', { className: 'message-body' }, h('div', { className: 'file-card' }, h('div', { className: 'file-row' }, h('div', { className: 'file-ext', 'aria-hidden': 'true' }, fileExtension(upload.file.name)), h('div', { className: 'file-info' }, h('div', { className: 'file-name', title: upload.file.name }, upload.file.name), h('div', { className: failed ? 'file-detail file-detail-error' : 'file-detail' }, detail), !failed && h('div', { className: 'progress' }, h('div', { className: 'progress-bar' }))), h('div', { className: 'file-actions' }, failed &&
        upload.retryable &&
        h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => retryUpload(upload) }, '重试'), h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => removeUpload(upload) }, failed ? '移除' : '取消'))))));
}
/** 只更新进度条，不重画整个消息列表，否则上传时选中的文字会丢失 */
function updateUploadProgress(upload) {
    const row = messagesEl.querySelector(`[data-upload="${upload.id}"]`);
    if (!row)
        return;
    const bar = row.querySelector('.progress-bar');
    const detail = row.querySelector('.file-detail');
    if (bar)
        bar.style.width = `${upload.progress * 100}%`;
    if (detail)
        detail.textContent = `${formatSize(upload.file.size)} · ${Math.round(upload.progress * 100)}%`;
}
function renderMessages(forceBottom = false) {
    const distanceToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const stick = forceBottom || state.stickToBottom || distanceToBottom < STICK_TO_BOTTOM_PX;
    state.stickToBottom = false;
    lastUserLook = userLook();
    const list = conversationMessages(state.active);
    const activeUploads = uploads.filter((upload) => upload.to === state.active);
    const nodes = [];
    if (list.length === 0 && activeUploads.length === 0) {
        nodes.push(h('div', { className: 'empty-chat' }, '还没有消息。可以直接输入文字、发表情，或把文件拖到这里。'));
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
    messagesEl.replaceChildren(...nodes);
    activeUploads.filter((upload) => upload.status === 'uploading').forEach(updateUploadProgress);
    if (stick)
        messagesEl.scrollTop = messagesEl.scrollHeight;
}
/** 会影响消息显示的同事信息：头像、昵称、气泡 */
function userLook() {
    return state.users.map((user) => `${user.id}:${user.name}:${user.avatar}:${user.bubble}`).join('|');
}
function renderAll(forceBottom = false) {
    markActiveAsRead();
    renderSidebar();
    renderChatHead();
    renderMessages(forceBottom);
    updateTitle();
}
function selectConversation(conversation) {
    state.active = conversation;
    closePopovers();
    renderAll(true);
    messageInput.focus();
}
// ---------- 输入栏的弹出菜单 ----------
const stickerPanel = createStickerPanel((sticker) => void sendContent({ sticker }));
byId('composer-popovers').append(stickerPanel.element);
function closePopovers() {
    stickerPanel.close();
    moreMenu.hidden = true;
    effectMenu.hidden = true;
    stickerButton.setAttribute('aria-expanded', 'false');
    moreButton.setAttribute('aria-expanded', 'false');
    effectButton.setAttribute('aria-expanded', 'false');
}
function togglePopover(button, show) {
    const wasOpen = button.getAttribute('aria-expanded') === 'true';
    closePopovers();
    if (!wasOpen)
        button.setAttribute('aria-expanded', String(show()));
}
stickerButton.addEventListener('click', () => togglePopover(stickerButton, () => {
    stickerPanel.toggle();
    return true;
}));
moreButton.addEventListener('click', () => togglePopover(moreButton, () => {
    moreMenu.hidden = false;
    return true;
}));
effectButton.addEventListener('click', () => togglePopover(effectButton, () => {
    effectMenu.hidden = false;
    return true;
}));
// 更多菜单：投票、接龙、大转盘、五子棋
const moreActions = [
    ['📊', '投票', () => openPollDialog(state.active)],
    ['📝', '接龙', () => openRelayDialog(state.active)],
    ['🎡', '大转盘', () => openWheelDialog(state.active)],
    ['⚫', '五子棋', () => startGomoku(state.active)],
];
moreMenu.replaceChildren(...moreActions.map(([icon, label, action]) => h('button', {
    className: 'menu-item',
    type: 'button',
    onclick: () => {
        closePopovers();
        action();
    },
}, h('span', { className: 'menu-icon', 'aria-hidden': 'true' }, icon), label)));
// 特效菜单：选中后在输入框上方显示，下一条文字消息带上这个特效
function setPendingEffect(id) {
    pendingEffect = id;
    const effect = effectInfo(id ?? undefined);
    effectChip.hidden = !effect;
    effectButton.classList.toggle('active', Boolean(effect));
    if (effect) {
        effectChip.replaceChildren(`✨ 下一条消息使用「${effect.name}」特效`, h('button', { className: 'chip-close', type: 'button', 'aria-label': '取消特效', onclick: () => setPendingEffect(null) }, '×'));
    }
}
effectMenu.replaceChildren(...['bubble', 'screen'].flatMap((kind) => [
    h('div', { className: 'menu-label' }, kind === 'bubble' ? '气泡特效' : '全屏特效'),
    ...EFFECTS.filter((effect) => effect.kind === kind).map((effect) => h('button', {
        className: 'menu-item',
        type: 'button',
        onclick: () => {
            closePopovers();
            setPendingEffect(effect.id);
            messageInput.focus();
        },
    }, effect.name)),
]));
document.addEventListener('click', (event) => {
    // 用事件路径判断，而不是 contains：点表情分类时面板会重画，被点的按钮已经不在页面上了
    const path = event.composedPath();
    const inside = [stickerPanel.element, moreMenu, effectMenu, stickerButton, moreButton, effectButton].some((el) => path.includes(el));
    if (!inside)
        closePopovers();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape')
        closePopovers();
});
// ---------- 发送 ----------
function resizeInput() {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${messageInput.scrollHeight + 2}px`;
}
async function sendContent(input) {
    try {
        applyMessage(await api.sendMessage(state.active, input));
    }
    catch (error) {
        handleError(error);
    }
}
async function submitMessage() {
    const text = messageInput.value.trim();
    if (!text || isSending)
        return;
    isSending = true;
    sendButton.disabled = true;
    try {
        applyMessage(await api.sendMessage(state.active, pendingEffect ? { text, effect: pendingEffect } : { text }));
        messageInput.value = '';
        setPendingEffect(null);
        resizeInput();
    }
    catch (error) {
        handleError(error);
    }
    finally {
        isSending = false;
        sendButton.disabled = false;
        messageInput.focus();
    }
}
// ---------- 发送文件：逐个排队上传 ----------
function enqueueFiles(files) {
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
    if (!added)
        return;
    renderMessages(true);
    void pumpUploads();
}
async function pumpUploads() {
    if (uploads.some((upload) => upload.status === 'uploading'))
        return;
    const upload = uploads.find((item) => item.status === 'queued');
    if (!upload)
        return;
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
    }
    catch (error) {
        if (error instanceof api.UploadCancelled) {
            uploads = uploads.filter((item) => item !== upload);
        }
        else if (error instanceof api.ApiError && error.status === 401) {
            showLogin();
            return;
        }
        else {
            upload.status = 'failed';
            upload.error = messageOf(error);
        }
        renderMessages();
    }
    void pumpUploads();
}
function retryUpload(upload) {
    upload.status = 'queued';
    upload.progress = 0;
    upload.error = undefined;
    renderMessages();
    void pumpUploads();
}
function removeUpload(upload) {
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
function isFileDrag(event) {
    return event.dataTransfer?.types.includes('Files') ?? false;
}
function hideDropOverlay() {
    dragDepth = 0;
    dropOverlay.hidden = true;
}
window.addEventListener('dragenter', (event) => {
    if (workspaceView.hidden || !isFileDrag(event))
        return;
    event.preventDefault();
    dragDepth += 1;
    dropText.textContent = `松开发送给${conversationName(state.active)}`;
    dropOverlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
    // 不阻止默认行为的话，浏览器会直接打开拖进来的文件
    if (isFileDrag(event))
        event.preventDefault();
});
window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event))
        return;
    dragDepth -= 1;
    if (dragDepth <= 0)
        hideDropOverlay();
});
window.addEventListener('drop', (event) => {
    if (!isFileDrag(event))
        return;
    event.preventDefault();
    hideDropOverlay();
    // 弹窗打开时（比如在选聊天背景）不处理，避免误发
    if (workspaceView.hidden || !event.dataTransfer || document.querySelector('dialog[open]'))
        return;
    const files = [];
    let hasFolder = false;
    for (const item of event.dataTransfer.items) {
        if (item.kind !== 'file')
            continue;
        if (item.webkitGetAsEntry()?.isDirectory) {
            hasFolder = true;
            continue;
        }
        const file = item.getAsFile();
        if (file)
            files.push(file);
    }
    if (hasFolder)
        showToast('暂不支持发送文件夹，请先压缩成一个文件');
    enqueueFiles(files);
});
// ---------- 服务器推送 ----------
function handleServerEvent(event) {
    if (event.type === 'users') {
        state.users = event.users;
        state.me = state.users.find((user) => user.id === state.me?.id) ?? state.me;
        renderSidebar();
        renderChatHead();
        // 只有头像、昵称、气泡变了才重画消息，单纯的上下线不重画，免得打断正在选中的文字
        if (userLook() !== lastUserLook)
            renderMessages();
        return;
    }
    if (event.type === 'deleted') {
        removeMessage(event.id);
        return;
    }
    if (event.type === 'stickers') {
        state.stickers = event.stickers;
        stickerPanel.refresh();
        renderMessages();
        return;
    }
    applyMessage(event.message);
}
/** 把服务器返回的完整数据合并进来。用合并而不是替换，避免覆盖刚通过推送收到的消息 */
function applySession(session) {
    state.me = session.me;
    state.users = session.users;
    state.stickers = session.stickers;
    state.limits = session.limits;
    for (const message of session.messages)
        state.messages.set(message.id, message);
    if (readMarks.firstSeen === undefined) {
        readMarks.firstSeen = session.messages.reduce((latest, message) => Math.max(latest, message.at), 0);
        writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
    }
    if (state.active !== GROUP && !userById(state.active))
        state.active = GROUP;
}
/** 重新拉取数据。连接刚建立或断线重连后调用，补上断线期间错过的内容 */
async function resync() {
    try {
        applySession(await api.fetchSession());
        renderAll();
    }
    catch (error) {
        if (error instanceof api.ApiError && error.status === 401)
            showLogin();
    }
}
function connectEvents() {
    events?.close();
    const source = new EventSource('/api/events');
    events = source;
    source.onopen = () => {
        banner.hidden = true;
        void resync();
    };
    source.onmessage = (event) => {
        handleServerEvent(JSON.parse(event.data));
    };
    source.onerror = () => {
        banner.hidden = false;
        // CONNECTING 时浏览器会自动重连；CLOSED 表示它放弃了（比如登录失效），要自己处理
        if (source.readyState !== EventSource.CLOSED)
            return;
        void resync().then(() => {
            if (events === source && !workspaceView.hidden)
                window.setTimeout(connectEvents, 3000);
        });
    };
}
// ---------- 登录和退出 ----------
function showLogin() {
    events?.close();
    events = null;
    state.me = null;
    state.users = [];
    state.messages.clear();
    uploads.forEach((upload) => upload.handle?.cancel());
    uploads = [];
    state.active = GROUP;
    closePopovers();
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    workspaceView.hidden = true;
    loginView.hidden = false;
    document.title = APP_TITLE;
    loginName.focus();
}
function showWorkspace(session) {
    applySession(session);
    loginView.hidden = true;
    workspaceView.hidden = false;
    loginCode.value = '';
    renderAll(true);
    connectEvents();
    messageInput.focus();
}
async function logout() {
    try {
        await api.logout();
    }
    catch {
        // 服务器连不上时也回到登录页
    }
    // 退出后清掉已读记录，下一位登录的人从自己的视角重新开始
    readMarks = { conversations: {} };
    writeStorage(READ_MARKS_KEY, JSON.stringify(readMarks));
    showLogin();
}
onRender(() => {
    if (!workspaceView.hidden)
        renderAll();
});
onUnauthorized(showLogin);
loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.hidden = true;
    loginSubmit.disabled = true;
    try {
        await api.login(loginName.value, loginCode.value);
        showWorkspace(await api.fetchSession());
    }
    catch (error) {
        loginError.textContent = messageOf(error);
        loginError.hidden = false;
    }
    finally {
        loginSubmit.disabled = false;
    }
});
profileButton.addEventListener('click', () => openMyProfile(() => void logout()));
chatTitle.addEventListener('click', () => {
    if (state.active !== GROUP)
        openUserCard(state.active, selectConversation);
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
    if (!workspaceView.hidden)
        renderAll();
});
// 文件到期时刷新一次，让下载按钮变成“已过期”
let lastExpiryCheck = Date.now();
window.setInterval(() => {
    const now = Date.now();
    const crossed = [...state.messages.values()].some(({ file }) => file && file.expiresAt > lastExpiryCheck && file.expiresAt <= now);
    lastExpiryCheck = now;
    if (crossed && !workspaceView.hidden)
        renderMessages();
}, 30_000);
function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark')
        document.documentElement.dataset.theme = theme;
}
byId('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme ??
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    writeStorage(THEME_KEY, next);
});
// 防止上传中途误关页面
window.addEventListener('beforeunload', (event) => {
    if (uploads.some((upload) => upload.status === 'uploading' || upload.status === 'queued'))
        event.preventDefault();
});
// ---------- 启动 ----------
async function start() {
    applyTheme(readStorage(THEME_KEY));
    void applyChatBackground();
    try {
        showWorkspace(await api.fetchSession());
    }
    catch (error) {
        showLogin();
        if (!(error instanceof api.ApiError && error.status === 401)) {
            loginError.textContent = messageOf(error);
            loginError.hidden = false;
        }
    }
}
void start();
