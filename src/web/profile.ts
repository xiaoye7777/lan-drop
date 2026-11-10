// 个人主页（改头像、昵称、签名、名片背景、气泡、聊天背景）和同事的资料卡
import { BUBBLES, LIMITS, NAMEPLATES, TIER_NAMES } from '../shared/catalog.js';
import type { UserInfo } from '../shared/types.js';
import * as api from './api.js';
import { CHAT_BACKGROUNDS, currentChatBackground, setChatBackground, setCustomChatBackground } from './chat-background.js';
import { bubbleClass, nameplateClass, renderAvatar } from './components.js';
import { h, openDialog, showToast } from './dom.js';
import { formatSize } from './format.js';
import { handleError, rerender, state } from './state.js';

/** 更新自己的资料后，同步到 state 里的两份数据 */
function applyMe(me: UserInfo): void {
  state.me = me;
  state.users = state.users.map((user) => (user.id === me.id ? me : user));
  rerender();
}

/** 把选中的图片裁成正方形、缩到 256×256。GIF 只会保留第一帧 */
async function cropAvatar(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片处理失败');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 256);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败'))), 'image/jpeg', 0.9),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 名片：头像 + 名字 + 签名，背景是名片背景。资料卡和个人主页的预览共用 */
function renderNameplateBanner(user: UserInfo, extra?: string): HTMLElement {
  return h(
    'div',
    { className: `profile-banner ${nameplateClass(user.nameplate)}` },
    renderAvatar(user, 'xl'),
    h(
      'div',
      { className: 'profile-banner-text' },
      h('div', { className: 'profile-name' }, user.name),
      h('div', { className: 'profile-bio' }, user.bio || '这个人很懒，什么都没写'),
      extra && h('div', { className: 'profile-extra' }, extra),
    ),
  );
}

/** 查看同事的资料卡 */
export function openUserCard(userId: string, onMessage: (id: string) => void): void {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  const isMe = user.id === state.me?.id;
  const dialog = openDialog(
    'user-card',
    renderNameplateBanner(user, `${user.online ? '在线' : '离线'} · ${user.ip}`),
    h(
      'div',
      { className: 'dialog-actions' },
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '关闭'),
      !isMe &&
        h(
          'button',
          {
            className: 'btn btn-primary',
            type: 'button',
            onclick: () => {
              dialog.close();
              onMessage(user.id);
            },
          },
          '发消息',
        ),
    ),
  );
}

/** 一组可以单选的样式按钮 */
function choiceGrid<T extends { id: string }>(
  items: T[],
  selected: string,
  renderItem: (item: T) => HTMLElement,
  onSelect: (id: string) => void,
): HTMLElement {
  const grid = h('div', { className: 'choice-grid', role: 'radiogroup' });
  const buttons = items.map((item) =>
    h(
      'button',
      {
        className: 'choice',
        type: 'button',
        role: 'radio',
        'aria-checked': String(item.id === selected),
        onclick: () => {
          for (const button of buttons) button.setAttribute('aria-checked', String(button === buttons[items.indexOf(item)]));
          onSelect(item.id);
        },
      },
      renderItem(item),
    ),
  );
  grid.append(...buttons);
  return grid;
}

export function openMyProfile(onLogout: () => void): void {
  const me = state.me;
  if (!me) return;
  // 编辑中的资料，点保存才提交
  const draft = { name: me.name, bio: me.bio, nameplate: me.nameplate, bubble: me.bubble };
  const preview = h('div', { className: 'profile-preview' });
  const updatePreview = () =>
    preview.replaceChildren(renderNameplateBanner({ ...(state.me ?? me), ...draft }));
  updatePreview();

  const error = h('p', { className: 'form-error', hidden: true });

  // ---- 头像：上传或移除后立即生效，不用点保存 ----
  const avatarActions = h('div', { className: 'inline-actions' });
  const renderAvatarActions = () => {
    const buttons: Node[] = [h('label', { className: 'btn btn-ghost btn-small' }, avatarInput, '更换头像')];
    if ((state.me ?? me).avatar !== null) {
      buttons.push(
        h(
          'button',
          {
            className: 'btn btn-ghost btn-small',
            type: 'button',
            onclick: async () => {
              try {
                applyMe(await api.deleteAvatar());
                updatePreview();
                renderAvatarActions();
              } catch (err) {
                handleError(err);
              }
            },
          },
          '移除头像',
        ),
      );
    }
    avatarActions.replaceChildren(...buttons);
  };
  const avatarInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    className: 'visually-hidden',
    onchange: async () => {
      const file = avatarInput.files?.[0];
      avatarInput.value = '';
      if (!file) return;
      try {
        const blob = await cropAvatar(file);
        if (blob.size > state.limits.maxAvatarBytes) throw new Error(`头像不能超过 ${formatSize(state.limits.maxAvatarBytes)}`);
        applyMe(await api.uploadAvatar(blob));
        updatePreview();
        renderAvatarActions();
      } catch (err) {
        handleError(err);
      }
    },
  });

  renderAvatarActions();

  // ---- 文字资料 ----
  const nameInput = h('input', { className: 'input', value: draft.name, maxLength: LIMITS.nameLength, required: true });
  const bioInput = h('input', { className: 'input', value: draft.bio, maxLength: LIMITS.bioLength, placeholder: '一句话介绍自己' });
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value.trim() || me.name;
    updatePreview();
  });
  bioInput.addEventListener('input', () => {
    draft.bio = bioInput.value.trim();
    updatePreview();
  });

  // ---- 样式选择 ----
  const nameplates = choiceGrid(
    NAMEPLATES,
    draft.nameplate,
    (item) =>
      h(
        'span',
        { className: `nameplate-sample ${nameplateClass(item.id)}` },
        h('span', { className: 'nameplate-sample-name' }, item.name),
        h('span', { className: `tier tier-${item.tier}` }, TIER_NAMES[item.tier]),
      ),
    (id) => {
      draft.nameplate = id;
      updatePreview();
    },
  );

  const bubbles = choiceGrid(
    BUBBLES,
    draft.bubble,
    (item) => h('span', { className: 'bubble-sample' }, h('span', { className: bubbleClass(item.id) }, item.name)),
    (id) => {
      draft.bubble = id;
    },
  );

  // 聊天背景只存在本机，选了立刻生效，不用点保存
  const backgroundInput = h('input', {
    type: 'file',
    accept: 'image/*',
    className: 'visually-hidden',
    onchange: async () => {
      const file = backgroundInput.files?.[0];
      backgroundInput.value = '';
      if (file) await setCustomChatBackground(file);
    },
  });
  const backgrounds = choiceGrid(
    CHAT_BACKGROUNDS,
    currentChatBackground(),
    (item) => h('span', { className: 'bg-sample', 'data-chat-bg': item.id }, item.name),
    (id) => void setChatBackground(id),
  );

  const save = async (event: Event) => {
    event.preventDefault();
    const current = state.me ?? me;
    const patch: api.ProfilePatch = {};
    if (nameInput.value.trim() !== current.name) patch.name = nameInput.value;
    if (bioInput.value.trim() !== current.bio) patch.bio = bioInput.value;
    if (draft.nameplate !== current.nameplate) patch.nameplate = draft.nameplate;
    if (draft.bubble !== current.bubble) patch.bubble = draft.bubble;
    try {
      if (Object.keys(patch).length > 0) applyMe(await api.updateProfile(patch));
      dialog.close();
      showToast('已保存');
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : '保存失败';
      error.hidden = false;
    }
  };

  const dialog = openDialog(
    'profile-dialog',
    h(
      'form',
      { onsubmit: save },
      h('h2', {}, '个人主页'),
      preview,
      avatarActions,
      h('div', { className: 'field-row' }, h('label', { className: 'field' }, h('span', {}, '昵称'), nameInput), h('label', { className: 'field' }, h('span', {}, '签名'), bioInput)),
      h('section', { className: 'profile-section' }, h('h3', {}, '名片背景', h('small', {}, '同事列表和资料卡里显示')), nameplates),
      h('section', { className: 'profile-section' }, h('h3', {}, '聊天气泡', h('small', {}, '大家看到你的消息都是这个样式')), bubbles),
      h(
        'section',
        { className: 'profile-section' },
        h('h3', {}, '聊天背景', h('small', {}, '只保存在这台电脑上，别人看不到')),
        backgrounds,
        h('label', { className: 'btn btn-ghost btn-small' }, backgroundInput, '用自己的图片'),
      ),
      error,
      h(
        'div',
        { className: 'dialog-actions' },
        h(
          'button',
          {
            className: 'btn btn-ghost btn-danger',
            type: 'button',
            onclick: () => {
              dialog.close();
              onLogout();
            },
          },
          '退出登录',
        ),
        h('span', { className: 'spacer' }),
        h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'),
        h('button', { className: 'btn btn-primary', type: 'submit' }, '保存'),
      ),
    ),
  );
}
