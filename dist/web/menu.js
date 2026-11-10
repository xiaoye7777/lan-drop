// 右键菜单：消息上的“引用、转发、多选、撤回”等操作。
// 页面上同时只有一个菜单，点菜单外面、按 Esc、滚动时关闭。
import { h } from './dom.js';
let current = null;
export function closeMenu() {
    current?.remove();
    current = null;
}
/** 在指定位置（视口坐标）打开菜单，超出屏幕时往回挪 */
export function openMenu(x, y, items) {
    closeMenu();
    const menu = h('div', { className: 'popover menu context-menu', role: 'menu' }, ...items.map((item) => h('button', {
        className: `menu-item${item.danger ? ' menu-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        onclick: () => {
            closeMenu();
            item.onSelect();
        },
    }, item.label)));
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    current = menu;
    menu.querySelector('button')?.focus();
}
/** 在按钮下方打开菜单 */
export function openMenuAt(anchor, items) {
    const rect = anchor.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 4, items);
}
document.addEventListener('pointerdown', (event) => {
    if (current && !event.composedPath().includes(current))
        closeMenu();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape')
        closeMenu();
});
window.addEventListener('resize', closeMenu);
// 消息列表滚动时菜单会和消息错位，直接关掉
document.addEventListener('scroll', closeMenu, true);
