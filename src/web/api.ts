// 和服务器通信的函数，页面逻辑都通过这里发请求
import type {
  ChatMessage,
  CustomSticker,
  Recipient,
  SessionInfo,
  StickerRef,
  UserInfo,
} from '../shared/types.js';

export class ApiError extends Error {
  constructor(
    /** 0 表示请求没有到达服务器（网络问题） */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 用户主动取消上传时抛出，不需要提示错误 */
export class UploadCancelled extends Error {}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiError(0, '连不上服务器，请检查网络');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? '请求失败，请重试');
  return data as T;
}

export const fetchSession = () => request<SessionInfo>('/api/session');

export const login = (name: string, code: string) => request('/api/login', { name, code });

export const logout = () => request('/api/logout', {});

export interface ProfilePatch {
  name?: string;
  bio?: string;
  nameplate?: string;
  bubble?: string;
}

export const updateProfile = (patch: ProfilePatch) => request<UserInfo>('/api/me', patch);

export const deleteAvatar = () => request<UserInfo>('/api/me/avatar/delete', {});

/** 各种消息的内容，一次只发一种 */
export type MessageInput =
  | { text: string; effect?: string }
  | { sticker: StickerRef }
  | { poll: { question: string; options: string[]; multi: boolean } }
  | { relay: { title: string; first?: string } }
  | { wheel: { title: string; options: string[] } }
  | { gomoku: Record<string, never> };

export const sendMessage = (to: Recipient, input: MessageInput) =>
  request<ChatMessage>('/api/messages', { to, ...input });

/** 对投票、接龙、五子棋消息的操作 */
export type ActionInput =
  | { type: 'vote'; choices: number[] }
  | { type: 'join'; text?: string }
  | { type: 'leave' }
  | { type: 'close' }
  | { type: 'move'; cell: number }
  | { type: 'resign' };

export const act = (messageId: string, action: ActionInput) =>
  request<ChatMessage>(`/api/messages/${messageId}/actions`, action);

/** 撤回自己的消息，服务器上永久删除 */
export const recall = (messageId: string) => request(`/api/messages/${messageId}/recall`, {});

export const deleteSticker = (id: string) => request(`/api/stickers/${id}/delete`, {});

export interface UploadHandle<T> {
  done: Promise<T>;
  cancel(): void;
}

/** 上传二进制内容。上传进度只有 XMLHttpRequest 能拿到，所以这里不用 fetch */
function uploadBinary<T>(path: string, body: Blob, onProgress?: (ratio: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const done = new Promise<T>((resolve, reject) => {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: T & { error?: string };
      try {
        data = JSON.parse(xhr.responseText) as T & { error?: string };
      } catch {
        reject(new ApiError(xhr.status, '上传失败，请重试'));
        return;
      }
      if (xhr.status === 200) resolve(data);
      else reject(new ApiError(xhr.status, data.error ?? '上传失败，请重试'));
    };
    xhr.onerror = () => reject(new ApiError(0, '网络中断，上传失败'));
    xhr.onabort = () => reject(new UploadCancelled());
  });
  xhr.open('POST', path);
  xhr.send(body);
  return { done, cancel: () => xhr.abort() };
}

export function uploadFile(file: File, to: Recipient, onProgress: (ratio: number) => void): UploadHandle<ChatMessage> {
  return uploadBinary(`/api/files?${new URLSearchParams({ to, name: file.name })}`, file, onProgress);
}

export const uploadAvatar = (image: Blob) => uploadBinary<UserInfo>('/api/me/avatar', image).done;

export const uploadSticker = (image: Blob, name: string) =>
  uploadBinary<CustomSticker>(`/api/stickers?${new URLSearchParams({ name })}`, image).done;
