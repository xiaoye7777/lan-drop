// 和服务器通信的函数，页面逻辑都通过这里发请求
import type { ChatMessage, Recipient, SessionInfo } from '../shared/types.js';

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

export const rename = (name: string) => request('/api/me', { name });

export const sendText = (to: Recipient, text: string) => request<ChatMessage>('/api/messages', { to, text });

export interface UploadHandle {
  done: Promise<ChatMessage>;
  cancel(): void;
}

/** 上传进度只有 XMLHttpRequest 能拿到，所以这里不用 fetch */
export function uploadFile(file: File, to: Recipient, onProgress: (ratio: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const query = new URLSearchParams({ to, name: file.name });
  const done = new Promise<ChatMessage>((resolve, reject) => {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: ChatMessage & { error?: string };
      try {
        data = JSON.parse(xhr.responseText) as ChatMessage & { error?: string };
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
  xhr.open('POST', `/api/files?${query}`);
  xhr.send(file);
  return { done, cancel: () => xhr.abort() };
}
