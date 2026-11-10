// 输入框里的 @：在全组聊天里输入 @ 时弹出同事列表，选中后插入“@昵称 ”。
// 发送时根据文字里出现的“@昵称”算出 @ 了谁，交给服务器校验。
import { MENTION_ALL } from '../shared/catalog.js';
import { renderAvatar } from './components.js';
import { h } from './dom.js';
import { displayName, state } from './state.js';

/** @ 后面跟着的这些字符算作昵称结束 */
const NAME_END = /^($|[\s,，.。!！?？:：;；、)）\]】])/;

interface Candidate {
  id: string;
  /** 插入到输入框里的名字：同事的真实昵称，大家看到的都一样 */
  name: string;
  /** 列表里显示的名字：有备注时显示备注 */
  label: string;
}

/** 文字里 @ 了哪些人。名字后面必须是空格、标点或结尾，避免“@张三丰”被当成 @张三 */
export function collectMentions(text: string): string[] {
  const has = (name: string) => {
    let index = text.indexOf(`@${name}`);
    while (index !== -1) {
      if (NAME_END.test(text.slice(index + name.length + 1))) return true;
      index = text.indexOf(`@${name}`, index + 1);
    }
    return false;
  };
  const ids = state.users.filter((user) => user.id !== state.me?.id && has(user.name)).map((user) => user.id);
  if (has('所有人')) ids.push(MENTION_ALL);
  return ids;
}

export function createMentionPicker(input: HTMLTextAreaElement, isGroup: () => boolean) {
  const element = h('div', { className: 'popover menu mention-menu', hidden: true, role: 'listbox', 'aria-label': '选择要 @ 的人' });
  let candidates: Candidate[] = [];
  let activeIndex = 0;
  /** 当前光标前面这段 @ 的起始位置 */
  let triggerStart = -1;

  const close = () => {
    element.hidden = true;
    triggerStart = -1;
  };

  const choose = (candidate: Candidate) => {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, triggerStart);
    const after = input.value.slice(caret);
    const insert = `@${candidate.name} `;
    input.value = before + insert + after;
    const position = before.length + insert.length;
    input.setSelectionRange(position, position);
    close();
    input.focus();
    input.dispatchEvent(new Event('input'));
  };

  const render = () => {
    element.replaceChildren(
      ...candidates.map((candidate, index) => {
        const user = state.users.find((item) => item.id === candidate.id);
        return h(
          'button',
          {
            className: 'menu-item',
            type: 'button',
            role: 'option',
            'aria-selected': String(index === activeIndex),
            // 用 mousedown 而不是 click：点击会先让输入框失去焦点
            onmousedown: (event: MouseEvent) => {
              event.preventDefault();
              choose(candidate);
            },
          },
          user ? renderAvatar(user, 'sm') : h('span', { className: 'avatar avatar-sm avatar-group', 'aria-hidden': 'true' }, '全'),
          candidate.label,
          candidate.label !== candidate.name && h('span', { className: 'menu-hint' }, candidate.name),
        );
      }),
    );
  };

  /** 输入变化时调用：光标前面是“@ + 若干字”就弹出列表 */
  const update = () => {
    if (!isGroup()) {
      close();
      return;
    }
    const caret = input.selectionStart ?? 0;
    const match = /@([^\s@]{0,20})$/.exec(input.value.slice(0, caret));
    if (!match) {
      close();
      return;
    }
    const keyword = match[1].toLowerCase();
    const all: Candidate[] = [
      { id: MENTION_ALL, name: '所有人', label: '所有人' },
      ...state.users
        .filter((user) => user.id !== state.me?.id)
        .map((user) => ({ id: user.id, name: user.name, label: displayName(user.id) })),
    ];
    candidates = all.filter((item) => !keyword || item.name.toLowerCase().includes(keyword) || item.label.toLowerCase().includes(keyword)).slice(0, 8);
    if (candidates.length === 0) {
      close();
      return;
    }
    triggerStart = caret - match[0].length;
    activeIndex = 0;
    element.hidden = false;
    render();
  };

  /** 列表打开时接管上下键、回车、Tab、Esc。返回 true 表示按键已经处理 */
  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (element.hidden || event.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + step + candidates.length) % candidates.length;
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      choose(candidates[activeIndex]);
    } else if (event.key === 'Escape') {
      close();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => window.setTimeout(close, 150));

  return { element, close, handleKeydown };
}
