// 创建 DOM 的小工具，以及提示、本地存储等各模块共用的功能

export type Child = Node | string | null | undefined | false;

/**
 * 创建 HTML 元素。内容都通过 textContent 写入，消息里的 HTML 不会被执行。
 * props 里 aria-* 和 data-* 写成属性，其余直接赋值给元素（className、onclick 等）。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key.startsWith('aria-') || key.startsWith('data-')) el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 创建 SVG 元素，属性一律用 setAttribute */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | string | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

export function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let toastTimer: number | undefined;

export function showToast(text: string): void {
  const toast = byId('toast');
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

/** 用户在系统里设置了“减少动态效果”时，不播放动画 */
export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- 浏览器本地存储（失败也不影响使用） ----------

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等情况下可能写不进去，忽略
  }
}

// ---------- 弹窗 ----------

/**
 * 创建一个模态弹窗，关闭后自动从页面移除。
 * 内容由调用方传入；返回的 dialog 已经打开。
 */
export function openDialog(className: string, ...children: Child[]): HTMLDialogElement {
  const dialog = h('dialog', { className: `dialog ${className}` }, ...children);
  dialog.addEventListener('close', () => dialog.remove());
  // 点击弹窗外面的遮罩时关闭
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** 弹出确认框，点确定返回 true */
export function confirmAction(title: string, text: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = openDialog(
      'dialog-small',
      h('h2', {}, title),
      h('p', { className: 'dialog-text' }, text),
      h(
        'div',
        { className: 'dialog-actions' },
        h('span', { className: 'spacer' }),
        h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'),
        h(
          'button',
          {
            className: 'btn btn-primary btn-danger-fill',
            type: 'button',
            onclick: () => {
              confirmed = true;
              dialog.close();
            },
          },
          okLabel,
        ),
      ),
    );
    dialog.addEventListener('close', () => resolve(confirmed));
  });
}

/**
 * 弹出一个输入框，确定时返回输入内容，取消时返回 null。
 * allowEmpty 为 true 时可以提交空内容（比如清除备注），返回空字符串
 */
export function promptText(
  title: string,
  options: { placeholder?: string; value?: string; maxLength: number; allowEmpty?: boolean },
): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', {
      className: 'input',
      placeholder: options.placeholder ?? '',
      value: options.value ?? '',
      maxLength: options.maxLength,
      required: !options.allowEmpty,
    });
    const form = h(
      'form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          const value = input.value.trim();
          if (!value && !options.allowEmpty) return;
          result = value;
          dialog.close();
        },
      },
      h('h2', {}, title),
      input,
      h(
        'div',
        { className: 'dialog-actions' },
        h('span', { className: 'spacer' }),
        h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'),
        h('button', { className: 'btn btn-primary', type: 'submit' }, '确定'),
      ),
    );
    const dialog = openDialog('dialog-small', form);
    dialog.addEventListener('close', () => resolve(result));
    input.select();
  });
}
