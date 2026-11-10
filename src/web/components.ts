// 多处共用的界面组件：头像、名片背景、气泡样式
import { BUBBLE_IDS, NAMEPLATE_IDS } from '../shared/catalog.js';
import type { UserInfo } from '../shared/types.js';
import { h } from './dom.js';

/** 没有头像时，按用户 id 固定选一个底色，同一个人每次颜色都一样 */
const AVATAR_COLORS = ['#0e6e78', '#2d6a9f', '#6a4c93', '#a0436b', '#b3612b', '#3f7d4e', '#566573', '#8a6d1f'];

function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

/** 头像：有上传的图片就显示图片，否则显示名字的第一个字 */
export function renderAvatar(
  user: Pick<UserInfo, 'id' | 'name' | 'avatar'>,
  size: AvatarSize,
  online?: boolean,
): HTMLElement {
  const el = h('span', { className: `avatar avatar-${size}`, 'aria-hidden': 'true' });
  if (user.avatar !== null) {
    el.append(h('img', { src: `/api/avatars/${user.id}?v=${user.avatar}`, alt: '', loading: 'lazy', decoding: 'async' }));
  } else {
    el.style.backgroundColor = colorFor(user.id);
    el.append([...user.name][0] ?? '?');
  }
  if (online !== undefined) el.append(h('span', { className: online ? 'status-dot' : 'status-dot status-offline' }));
  return el;
}

/** 名片背景的类名。只认目录里有的 id，避免把任意字符串拼进类名 */
export function nameplateClass(id: string | undefined): string {
  return `np np-${id && NAMEPLATE_IDS.has(id) ? id : 'default'}`;
}

export function bubbleClass(id: string | undefined): string {
  return `bubble bubble-${id && BUBBLE_IDS.has(id) ? id : 'default'}`;
}
