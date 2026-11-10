import * as api from './api.js';
import { confirmAction, h, openDialog, readStorage, showToast, writeStorage } from './dom.js';
import { formatDateTime, formatSize } from './format.js';
import { handleError, state } from './state.js';
/** 浏览器记住已经弹过的提醒编号，同一次提醒只弹一回 */
const SEEN_ALERT_KEY = 'lan-drop-storage-alert';
export function formatGb(bytes) {
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : formatSize(bytes);
}
function usageText() {
    const { used, limit } = state.storage;
    return `已用 ${formatGb(used)} / ${formatGb(limit)}（${Math.min(100, Math.round((used / limit) * 100))}%）`;
}
function usageBar() {
    const ratio = Math.min(1, state.storage.used / (state.storage.limit || 1));
    const bar = h('div', { className: 'usage-bar-fill' });
    bar.style.width = `${ratio * 100}%`;
    return h('div', { className: `usage-bar usage-${state.storage.level}` }, bar);
}
/** 侧边栏底部的用量，点开是清理文件的弹窗 */
export function renderStorageMeter(button) {
    button.className = `storage-meter storage-${state.storage.level}`;
    button.replaceChildren(h('span', {}, `存储 ${formatGb(state.storage.used)} / ${formatGb(state.storage.limit)}`), usageBar());
}
/** 聊天区顶部的提示条：用到 80% 以上才显示 */
export function renderStorageBanner(banner) {
    const { level } = state.storage;
    banner.hidden = level === 'ok';
    if (level === 'ok')
        return;
    banner.className = `banner storage-banner storage-${level}`;
    banner.replaceChildren(level === 'full' ? `存储空间已满，暂时不能发消息和文件。${usageText()}` : `存储空间快满了，${usageText()}`, h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: openStorageDialog }, '清理文件'));
}
/** 升到 80% 或满了的时候弹一次提醒。没在线的同事下次打开页面时补弹 */
export function maybeAlertStorage() {
    const { level, alertId } = state.storage;
    const seen = Number(readStorage(SEEN_ALERT_KEY) ?? 0);
    if (level === 'ok' || alertId <= seen)
        return;
    writeStorage(SEEN_ALERT_KEY, String(alertId));
    // 80% 的提醒还没关、又满了：换成新的提醒，不要叠两个
    document.querySelectorAll('dialog.storage-alert[open]').forEach((dialog) => dialog.close());
    const full = level === 'full';
    const dialog = openDialog('dialog-small storage-alert', h('h2', {}, full ? '存储空间已满' : '存储空间已用 80%'), usageBar(), h('p', { className: 'dialog-text' }, full
        ? `${usageText()}。现在不能发消息和文件，需要有人清理掉一些不用的文件。`
        : `${usageText()}。满了以后大家都不能发消息和文件，请清理一下自己不再需要的文件。`), h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '知道了'), h('button', {
        className: 'btn btn-primary',
        type: 'button',
        onclick: () => {
            dialog.close();
            openStorageDialog();
        },
    }, '去清理')));
}
/** 清理文件：列出能看到的文件，从大到小。自己上传的可以清理；在服务器电脑上打开时可以清理任何文件 */
export function openStorageDialog() {
    const summary = h('div', { className: 'storage-summary' });
    const list = h('div', { className: 'storage-list' }, h('div', { className: 'empty-hint' }, '加载中…'));
    const onlyMine = h('input', { type: 'checkbox', checked: !state.admin });
    let files = [];
    const renderSummary = () => summary.replaceChildren(h('div', {}, usageText()), usageBar(), h('p', { className: 'dialog-note' }, state.admin
        ? '你在服务器电脑上打开，可以清理任何人的文件。别人私聊里的文件不显示文件名。'
        : '只能清理自己上传的文件。清理后文件从服务器上删除，聊天记录里显示“已被清理”。'));
    const remove = async (file) => {
        const ok = await confirmAction('清理这个文件？', `「${file.name}」（${formatSize(file.size)}）会从服务器上删除，所有人都不能再下载，无法恢复。`, '清理');
        if (!ok)
            return;
        try {
            await api.deleteFile(file.id);
            showToast('已清理');
            await load();
        }
        catch (error) {
            handleError(error);
        }
    };
    const renderList = () => {
        const shown = files.filter((file) => !onlyMine.checked || file.owner === state.me?.id);
        list.replaceChildren(...(shown.length === 0
            ? [h('div', { className: 'empty-hint' }, onlyMine.checked ? '你还没有上传过文件' : '还没有文件')]
            : shown.map((file) => h('div', { className: 'storage-row' }, h('div', { className: 'storage-info' }, h('div', { className: 'file-name', title: file.name }, file.name), h('div', { className: 'file-detail' }, `${file.ownerName} · ${file.where} · ${formatDateTime(file.at)}`)), h('span', { className: 'storage-size' }, formatSize(file.size)), file.canDelete
                ? h('button', { className: 'btn btn-ghost btn-small btn-danger', type: 'button', onclick: () => void remove(file) }, '清理')
                : h('span', { className: 'storage-placeholder' })))));
    };
    const load = async () => {
        try {
            const result = await api.fetchStorage();
            state.storage = result.storage;
            files = result.files;
            renderSummary();
            renderList();
        }
        catch (error) {
            handleError(error);
        }
    };
    onlyMine.addEventListener('change', renderList);
    renderSummary();
    const dialog = openDialog('storage-dialog', h('h2', {}, '存储空间'), summary, h('label', { className: 'check' }, onlyMine, '只看我上传的'), list, h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '关闭')));
    void load();
}
