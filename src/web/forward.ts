// 转发：选择转发给哪些会话，然后合并成一条聊天记录，或者逐条转发
import { LIMITS } from '../shared/catalog.js';
import type { Recipient } from '../shared/types.js';
import * as api from './api.js';
import { renderAvatar } from './components.js';
import { h, openDialog, showToast } from './dom.js';
import { applyMessage, conversationName, GROUP, handleError, state } from './state.js';

/** 打开“转发给”弹窗。转发成功后调用 onDone */
export function openForwardDialog(ids: string[], mode: 'merge' | 'single', onDone: () => void): void {
  const chosen = new Set<Recipient>();
  const filter = h('input', { className: 'input', type: 'search', placeholder: '搜索同事', 'aria-label': '搜索同事' });
  const list = h('div', { className: 'pick-list', role: 'group', 'aria-label': '转发给' });
  const sendButton = h('button', { className: 'btn btn-primary', type: 'submit' }, '发送');
  const error = h('p', { className: 'form-error', hidden: true });

  const targets: Recipient[] = [
    GROUP,
    ...state.users
      .filter((user) => user.id !== state.me?.id)
      .sort((a, b) => Number(b.online) - Number(a.online) || conversationName(a.id).localeCompare(conversationName(b.id), 'zh'))
      .map((user) => user.id),
  ];

  const updateButton = () => {
    sendButton.disabled = chosen.size === 0;
    sendButton.textContent = chosen.size > 0 ? `发送（${chosen.size}）` : '发送';
  };

  const renderList = () => {
    const keyword = filter.value.trim().toLowerCase();
    const rows = targets
      .filter((id) => {
        if (!keyword) return true;
        const user = state.users.find((item) => item.id === id);
        return [conversationName(id), user?.name ?? ''].some((name) => name.toLowerCase().includes(keyword));
      })
      .map((id) => {
        const user = state.users.find((item) => item.id === id);
        const checkbox = h('input', {
          type: 'checkbox',
          checked: chosen.has(id),
          onchange: () => {
            if (checkbox.checked) {
              if (chosen.size >= LIMITS.forwardMaxTargets) {
                checkbox.checked = false;
                showToast(`一次最多转发给 ${LIMITS.forwardMaxTargets} 个会话`);
                return;
              }
              chosen.add(id);
            } else {
              chosen.delete(id);
            }
            updateButton();
          },
        });
        const avatar = user
          ? renderAvatar(user, 'sm', user.online)
          : h('span', { className: 'avatar avatar-sm avatar-group', 'aria-hidden': 'true' }, '全');
        return h('label', { className: 'pick-row' }, checkbox, avatar, h('span', { className: 'pick-name' }, conversationName(id)));
      });
    list.replaceChildren(...(rows.length > 0 ? rows : [h('div', { className: 'empty-hint' }, '没有找到')]));
  };

  filter.addEventListener('input', renderList);
  renderList();
  updateButton();

  const submit = async (event: Event) => {
    event.preventDefault();
    if (chosen.size === 0) return;
    sendButton.disabled = true;
    try {
      const { messages } = await api.forward(ids, [...chosen], mode);
      messages.forEach(applyMessage);
      dialog.close();
      showToast('已转发');
      onDone();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : '转发失败';
      error.hidden = false;
      updateButton();
      if (!(err instanceof api.ApiError) || err.status === 401) handleError(err);
    }
  };

  const description =
    mode === 'merge' ? `把选中的 ${ids.length} 条消息合并成一条聊天记录发出去` : ids.length > 1 ? `逐条转发 ${ids.length} 条消息` : '转发这条消息';
  const dialog = openDialog(
    'forward-dialog',
    h(
      'form',
      { onsubmit: submit },
      h('h2', {}, '转发给'),
      h('p', { className: 'dialog-text' }, description),
      filter,
      list,
      error,
      h(
        'div',
        { className: 'dialog-actions' },
        h('span', { className: 'spacer' }),
        h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'),
        sendButton,
      ),
    ),
  );
  filter.focus();
}
