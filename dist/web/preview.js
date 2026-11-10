import { h, openDialog } from './dom.js';
import { formatSize } from './format.js';
export function openImagePreview(file) {
    const dialog = openDialog('lightbox', h('figure', {}, h('img', { src: `/api/files/${file.id}/preview`, alt: file.name, decoding: 'async' }), h('figcaption', {}, h('span', { className: 'lightbox-name' }, `${file.name} · ${formatSize(file.size)}`), h('a', { className: 'btn btn-ghost btn-small', href: `/api/files/${file.id}`, download: file.name }, '下载原图'), h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => dialog.close() }, '关闭'))));
}
