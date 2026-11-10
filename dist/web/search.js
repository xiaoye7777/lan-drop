// 搜索聊天记录：在服务器上搜自己能看到的消息，点结果跳到那条消息
import { LIMITS, summarize, truncate } from '../shared/catalog.js';
import * as api from './api.js';
import { h, openDialog } from './dom.js';
import { formatDateTime } from './format.js';
import { conversationName, displayName, handleError } from './state.js';
const SEARCH_DELAY_MS = 300;
/** 把摘要里的关键词标出来。只拆文字，不拼 HTML */
function highlight(text, keyword) {
    const nodes = [];
    const lower = text.toLowerCase();
    const needle = keyword.toLowerCase();
    let last = 0;
    for (let index = lower.indexOf(needle); index !== -1 && needle; index = lower.indexOf(needle, last)) {
        if (index > last)
            nodes.push(document.createTextNode(text.slice(last, index)));
        nodes.push(h('mark', {}, text.slice(index, index + needle.length)));
        last = index + needle.length;
    }
    nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
}
/** 结果里显示的一段文字：长消息从关键词附近开始截，保证能看到关键词 */
function snippet(message, keyword) {
    if (message.text === undefined)
        return summarize(message);
    const flat = message.text.replace(/\s+/g, ' ');
    const index = flat.toLowerCase().indexOf(keyword.toLowerCase());
    if (index <= 30)
        return truncate(flat, LIMITS.summaryLength);
    return `…${truncate(flat.slice(index - 20), LIMITS.summaryLength)}`;
}
export function openSearchDialog(onJump) {
    const input = h('input', {
        className: 'input',
        type: 'search',
        placeholder: '搜索文字、文件名',
        maxLength: LIMITS.searchQueryLength,
        'aria-label': '搜索聊天记录',
    });
    const results = h('div', { className: 'search-results' }, h('div', { className: 'empty-hint' }, '输入关键词搜索所有聊天记录'));
    let timer;
    let latest = 0;
    const run = async () => {
        const keyword = input.value.trim();
        const requestId = (latest += 1);
        if (!keyword) {
            results.replaceChildren(h('div', { className: 'empty-hint' }, '输入关键词搜索所有聊天记录'));
            return;
        }
        try {
            const { hits } = await api.search(keyword);
            // 打字很快时，只显示最后一次搜索的结果
            if (requestId !== latest)
                return;
            results.replaceChildren(...(hits.length === 0
                ? [h('div', { className: 'empty-hint' }, '没有找到')]
                : hits.map((hit) => {
                    const { message } = hit;
                    return h('button', {
                        className: 'search-hit',
                        type: 'button',
                        onclick: () => {
                            dialog.close();
                            onJump(hit);
                        },
                    }, h('span', { className: 'search-meta' }, `${conversationName(hit.conversation)} · ${displayName(message.from, message.fromName)} · ${formatDateTime(message.at)}`), h('span', { className: 'search-text' }, ...highlight(snippet(message, keyword), keyword)));
                })), hits.length >= LIMITS.searchMaxResults ? h('div', { className: 'dialog-note' }, `只显示最近的 ${LIMITS.searchMaxResults} 条，换个更具体的词试试`) : '');
        }
        catch (error) {
            handleError(error);
        }
    };
    input.addEventListener('input', () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void run(), SEARCH_DELAY_MS);
    });
    const dialog = openDialog('search-dialog', h('h2', {}, '搜索聊天记录'), input, results, h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '关闭')));
    input.focus();
}
