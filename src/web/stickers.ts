// 表情：显示消息里的表情，以及输入框上方的表情面板
import { BUILTIN_STICKERS, LIMITS, STICKER_PACKS } from '../shared/catalog.js';
import type { BuiltinSticker } from '../shared/catalog.js';
import type { StickerRef } from '../shared/types.js';
import * as api from './api.js';
import { h, readStorage, showToast, writeStorage } from './dom.js';
import { drawFace } from './faces.js';
import { formatSize } from './format.js';
import { handleError, state } from './state.js';

const TAB_KEY = 'lan-drop-sticker-tab';
const CUSTOM_TAB = 'custom';
/** 新收到的表情播放一遍动作的时长 */
export const STICKER_PLAY_MS = 1800;

function renderBuiltin(sticker: BuiltinSticker, loop: boolean): HTMLElement {
  const { art } = sticker;
  const root = h('div', {
    className: `sticker sticker-${art.kind}${loop ? ' loop' : ''}`,
    'data-motion': sticker.motion,
    role: 'img',
    'aria-label': `表情：${art.text}`,
  });
  if (art.kind === 'meme') {
    root.classList.add(`tone-${art.tone}`);
    root.append(
      h('span', { className: 'sticker-art' }, h('span', { className: 'sticker-emoji' }, art.emoji)),
      h('span', { className: 'sticker-text' }, art.text),
    );
  } else if (art.kind === 'face') {
    root.append(h('span', { className: 'sticker-art' }, drawFace(art)), h('span', { className: 'sticker-caption' }, art.text));
  } else {
    root.append(h('span', { className: 'sticker-art sticker-big-emoji' }, art.emoji), h('span', { className: 'sticker-caption' }, art.text));
  }
  return root;
}

/** 消息里的表情。play 为 true 时播放一遍动作（刚收到时） */
export function renderSticker(ref: StickerRef, play: boolean): HTMLElement {
  if (ref.source === 'builtin') {
    const found = BUILTIN_STICKERS.get(ref.id);
    if (!found) return h('div', { className: 'sticker sticker-missing' }, '未知表情');
    const el = renderBuiltin(found.sticker, found.pack.loop);
    if (play) el.classList.add('playing');
    return el;
  }
  const custom = state.stickers.find((sticker) => sticker.id === ref.id);
  if (!custom) return h('div', { className: 'sticker sticker-missing' }, '表情已被删除');
  return h('img', {
    className: 'sticker sticker-custom',
    src: `/api/stickers/${custom.id}`,
    alt: `表情：${custom.name}`,
    title: custom.name,
    loading: 'lazy',
    decoding: 'async',
  });
}

/**
 * 表情面板。onPick 在选中表情时调用，由主界面负责发送。
 * 面板内容在打开时才生成，内置表情有八十多个，没必要每次重画页面都生成一遍。
 */
export function createStickerPanel(onPick: (ref: StickerRef) => void) {
  const tabs = h('div', { className: 'panel-tabs', role: 'tablist' });
  const grid = h('div', { className: 'sticker-grid' });
  const element = h('div', { className: 'popover sticker-panel', hidden: true, 'aria-label': '表情' }, tabs, grid);
  let activeTab = readStorage(TAB_KEY) ?? STICKER_PACKS[0].id;

  const pick = (ref: StickerRef) => {
    element.hidden = true;
    onPick(ref);
  };

  function renderTabs(): void {
    const items = [...STICKER_PACKS.map((pack) => ({ id: pack.id, name: pack.name })), { id: CUSTOM_TAB, name: '自定义' }];
    tabs.replaceChildren(
      ...items.map((item) =>
        h(
          'button',
          {
            className: 'panel-tab',
            type: 'button',
            role: 'tab',
            'aria-selected': String(item.id === activeTab),
            onclick: () => {
              activeTab = item.id;
              writeStorage(TAB_KEY, activeTab);
              render();
            },
          },
          item.name,
        ),
      ),
    );
  }

  function renderBuiltinGrid(): void {
    const pack = STICKER_PACKS.find((item) => item.id === activeTab) ?? STICKER_PACKS[0];
    grid.className = 'sticker-grid';
    grid.replaceChildren(
      ...pack.stickers.map((sticker) =>
        h(
          'button',
          {
            className: 'sticker-choice',
            type: 'button',
            title: sticker.art.text,
            onclick: () => pick({ source: 'builtin', id: sticker.id }),
          },
          renderBuiltin(sticker, pack.loop),
        ),
      ),
    );
  }

  async function addCustom(file: File): Promise<void> {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      showToast('只支持 PNG、JPEG、GIF、WebP 图片');
      return;
    }
    if (file.size > state.limits.maxStickerBytes) {
      showToast(`表情不能超过 ${formatSize(state.limits.maxStickerBytes)}`);
      return;
    }
    const name = [...file.name.replace(/\.[^.]+$/, '')].slice(0, LIMITS.stickerNameLength).join('');
    try {
      const sticker = await api.uploadSticker(file, name);
      if (!state.stickers.some((item) => item.id === sticker.id)) state.stickers = [...state.stickers, sticker];
      render();
    } catch (error) {
      handleError(error);
    }
  }

  async function removeCustom(id: string): Promise<void> {
    try {
      await api.deleteSticker(id);
      state.stickers = state.stickers.filter((sticker) => sticker.id !== id);
      render();
    } catch (error) {
      handleError(error);
    }
  }

  function renderCustomGrid(): void {
    const input = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      className: 'visually-hidden',
      onchange: () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) void addCustom(file);
      },
    });
    grid.className = 'sticker-grid sticker-grid-custom';
    grid.replaceChildren(
      h('label', { className: 'sticker-choice sticker-add', title: '添加表情（全组共享）' }, input, h('span', { 'aria-hidden': 'true' }, '＋'), h('span', {}, '添加')),
      ...state.stickers.map((sticker) =>
        h(
          'div',
          { className: 'sticker-custom-item' },
          h(
            'button',
            {
              className: 'sticker-choice',
              type: 'button',
              title: sticker.name,
              onclick: () => pick({ source: 'custom', id: sticker.id }),
            },
            renderSticker({ source: 'custom', id: sticker.id }, false),
          ),
          sticker.owner === state.me?.id &&
            h(
              'button',
              {
                className: 'sticker-delete',
                type: 'button',
                'aria-label': `删除表情 ${sticker.name}`,
                title: '删除（只有添加的人能删）',
                onclick: () => void removeCustom(sticker.id),
              },
              '×',
            ),
        ),
      ),
    );
    if (state.stickers.length === 0) {
      grid.append(h('p', { className: 'panel-hint' }, '把你收藏的表情包加进来，全组都能用。支持 GIF 动图，单个不超过 2 MB。'));
    }
  }

  function render(): void {
    renderTabs();
    if (activeTab === CUSTOM_TAB) renderCustomGrid();
    else renderBuiltinGrid();
  }

  return {
    element,
    toggle(): void {
      element.hidden = !element.hidden;
      if (!element.hidden) render();
    },
    close(): void {
      element.hidden = true;
    },
    /** 自定义表情列表变了，面板开着时要刷新 */
    refresh(): void {
      if (!element.hidden && activeTab === CUSTOM_TAB) render();
    },
  };
}
