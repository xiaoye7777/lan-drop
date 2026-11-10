// 聊天区背景。只保存在自己的浏览器里，不会上传，其他同事看不到。
// 预设背景用 CSS 画（见 style.css 的 data-chat-bg）；自定义图片存在浏览器的 IndexedDB 里。
import { byId, readStorage, showToast, writeStorage } from './dom.js';

const KEY = 'lan-drop-chat-bg';
const DB_NAME = 'lan-drop';
const STORE = 'files';
const IMAGE_KEY = 'chat-background';
/** 自定义背景图缩到这个宽度以内再保存，太大的图没必要，也占浏览器空间 */
const MAX_WIDTH = 1920;

export const CHAT_BACKGROUNDS = [
  { id: 'none', name: '默认' },
  { id: 'dots', name: '点阵' },
  { id: 'grid', name: '网格' },
  { id: 'waves', name: '波纹' },
  { id: 'stars', name: '星空' },
  { id: 'aurora', name: '极光' },
  { id: 'sunset', name: '晚霞' },
  { id: 'paper', name: '纸张' },
];

let objectUrl: string | null = null;
/** IndexedDB 不可用时（比如隐私模式），自定义图片只在这次打开期间有效 */
let memoryImage: Blob | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function loadImage(): Promise<Blob | null> {
  if (memoryImage) return memoryImage;
  try {
    return ((await withStore('readonly', (store) => store.get(IMAGE_KEY))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

export function currentChatBackground(): string {
  const saved = readStorage(KEY);
  return saved === 'custom' || CHAT_BACKGROUNDS.some((item) => item.id === saved) ? (saved as string) : 'none';
}

/** 把保存的背景设置应用到聊天区 */
export async function applyChatBackground(): Promise<void> {
  const messages = byId('messages');
  const id = currentChatBackground();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  messages.style.backgroundImage = '';
  if (id === 'custom') {
    const image = await loadImage();
    if (image) {
      objectUrl = URL.createObjectURL(image);
      messages.style.backgroundImage = `url("${objectUrl}")`;
    } else {
      messages.dataset.chatBg = 'none';
      return;
    }
  }
  messages.dataset.chatBg = id;
}

export async function setChatBackground(id: string): Promise<void> {
  writeStorage(KEY, id);
  await applyChatBackground();
}

/** 把图片缩小后转成 JPEG */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败'))), 'image/jpeg', 0.85),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function setCustomChatBackground(file: File): Promise<void> {
  let image: Blob;
  try {
    image = await shrink(file);
  } catch {
    showToast('这张图片打不开，换一张试试');
    return;
  }
  try {
    await withStore('readwrite', (store) => store.put(image, IMAGE_KEY));
    memoryImage = null;
  } catch {
    memoryImage = image;
    showToast('浏览器不允许保存图片，刷新页面后背景会恢复默认');
  }
  await setChatBackground('custom');
}
