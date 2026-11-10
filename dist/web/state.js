// 页面的全部状态，以及从状态推算出来的常用信息。
// 各模块直接读写 state；改完后调用 rerender() 让主界面重画。
import { MENTION_ALL } from '../shared/catalog.js';
import { ApiError } from './api.js';
import { messageOf, showToast } from './dom.js';
import { playScreenEffect } from './effects.js';
export const GROUP = 'all';
export const state = {
    me: null,
    users: [],
    messages: new Map(),
    stickers: [],
    limits: { maxFileBytes: 0, maxStickerBytes: 0, maxAvatarBytes: 0 },
    /** 自己给同事起的备注，只有自己能看到 */
    remarks: {},
    storage: { used: 0, limit: 0, level: 'ok', alertId: 0 },
    /** 在服务器电脑上用 localhost 打开时为 true，可以清理任何人的文件 */
    admin: false,
    /** 还有更早的消息没加载的会话 */
    older: new Set(),
    /** 当前打开的会话：全组，或私聊对方的 id */
    active: GROUP,
    /**
     * 正在播放动画的消息和开始时间。消息列表重画时据此接着播放，
     * 而不是从头开始或者突然停住。
     */
    animations: new Map(),
    /** 已经点开看过的隐形墨水消息 */
    revealedInk: new Set(),
    /** 自己刚发了消息，下次重画时滚到最底部 */
    stickToBottom: false,
    /** 多选模式：选中的消息 id（准备转发） */
    selecting: false,
    selected: new Set(),
    /** 正在引用回复的消息 */
    replyTo: null,
    /** 要闪一下提示位置的消息（点了引用或搜索结果跳过去时） */
    highlight: null,
};
export function userById(id) {
    return state.users.find((user) => user.id === id);
}
/** 显示用的名字：有备注用备注，否则用对方现在的昵称，人已经不在了就用消息里记的昵称 */
export function displayName(userId, fallback = '已离开的同事') {
    return state.remarks[userId] || userById(userId)?.name || fallback;
}
/** 一条消息属于哪个会话：全组，或私聊的对方 */
export function conversationOf(message) {
    if (message.to === GROUP)
        return GROUP;
    return message.from === state.me?.id ? message.to : message.from;
}
export function conversationMessages(conversation) {
    return [...state.messages.values()]
        .filter((message) => conversationOf(message) === conversation)
        .sort((a, b) => a.at - b.at);
}
export function conversationName(conversation) {
    if (conversation === GROUP)
        return '全组';
    return displayName(conversation);
}
/** 这条消息有没有 @ 我（包括 @所有人），自己发的不算 */
export function mentionsMe(message) {
    if (!state.me || message.from === state.me.id)
        return false;
    return Boolean(message.mentions?.some((id) => id === state.me?.id || id === MENTION_ALL));
}
/** 消息比这个会话里已加载的最早一条还早、而且中间还有没加载的，说明它不在当前加载的范围里 */
function outsideLoadedRange(message) {
    const conversation = conversationOf(message);
    if (!state.older.has(conversation))
        return false;
    const oldest = conversationMessages(conversation)[0];
    return oldest !== undefined && message.at < oldest.at;
}
/**
 * 收到服务器返回的消息后存起来并重画。同一条消息可能收到多次（自己发送的响应、推送、状态更新），
 * 只有第一次收到时才播放特效和动画；历史消息不经过这里，所以不会重播。
 */
export function applyMessage(message) {
    const isNew = !state.messages.has(message.id);
    // 很早以前的消息有更新（比如老投票有人投了票），而它还没加载，就不用管，免得聊天记录中间出现断档
    if (isNew && outsideLoadedRange(message))
        return;
    state.messages.set(message.id, message);
    if (isNew) {
        const visible = conversationOf(message) === state.active && document.visibilityState === 'visible';
        if (message.effect || message.wheel || message.sticker)
            state.animations.set(message.id, performance.now());
        if (message.effect && visible)
            playScreenEffect(message.effect);
        if (message.nudge) {
            state.animations.set(message.id, performance.now());
            // 被拍的是自己：整个窗口抖一下
            if (message.nudge.target === state.me?.id && visible)
                shakeScreen();
        }
        if (message.from === state.me?.id)
            state.stickToBottom = true;
    }
    rerender();
}
export function shakeScreen() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches)
        return;
    document.body.classList.remove('screen-shake');
    // 读一次布局，让浏览器认为类名被重新加上，动画才会再播一遍
    void document.body.offsetWidth;
    document.body.classList.add('screen-shake');
    window.setTimeout(() => document.body.classList.remove('screen-shake'), 600);
}
/** 动画已经播放了多久（毫秒）；没在播放或已经播完时返回 null */
export function animationElapsed(id, duration) {
    const start = state.animations.get(id);
    if (start === undefined)
        return null;
    const elapsed = performance.now() - start;
    if (elapsed >= duration) {
        state.animations.delete(id);
        return null;
    }
    return elapsed;
}
// ---------- 重画和错误处理的挂钩，由 app.ts 注册 ----------
let renderHook = () => undefined;
let unauthorizedHook = () => undefined;
export function onRender(fn) {
    renderHook = fn;
}
export function onUnauthorized(fn) {
    unauthorizedHook = fn;
}
export function rerender() {
    renderHook();
}
/** 统一处理请求失败：登录失效回到登录页，其他错误弹出提示 */
export function handleError(error) {
    if (error instanceof ApiError && error.status === 401)
        unauthorizedHook();
    else
        showToast(messageOf(error));
}
