export class ApiError extends Error {
    status;
    constructor(
    /** 0 表示请求没有到达服务器（网络问题） */
    status, message) {
        super(message);
        this.status = status;
    }
}
/** 用户主动取消上传时抛出，不需要提示错误 */
export class UploadCancelled extends Error {
}
async function request(path, body) {
    let res;
    try {
        res = await fetch(path, body === undefined
            ? undefined
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    catch {
        throw new ApiError(0, '连不上服务器，请检查网络');
    }
    const data = (await res.json().catch(() => ({})));
    if (!res.ok)
        throw new ApiError(res.status, data.error ?? '请求失败，请重试');
    return data;
}
export const fetchSession = () => request('/api/session');
export const login = (name, code) => request('/api/login', { name, code });
export const logout = () => request('/api/logout', {});
export const updateProfile = (patch) => request('/api/me', patch);
export const deleteAvatar = () => request('/api/me/avatar/delete', {});
export const sendMessage = (to, input) => request('/api/messages', { to, ...input });
export const act = (messageId, action) => request(`/api/messages/${messageId}/actions`, action);
/** 撤回自己的消息，服务器上永久删除 */
export const recall = (messageId) => request(`/api/messages/${messageId}/recall`, {});
export const deleteSticker = (id) => request(`/api/stickers/${id}/delete`, {});
/** 上传二进制内容。上传进度只有 XMLHttpRequest 能拿到，所以这里不用 fetch */
function uploadBinary(path, body, onProgress) {
    const xhr = new XMLHttpRequest();
    const done = new Promise((resolve, reject) => {
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable)
                onProgress?.(event.loaded / event.total);
        };
        xhr.onload = () => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            }
            catch {
                reject(new ApiError(xhr.status, '上传失败，请重试'));
                return;
            }
            if (xhr.status === 200)
                resolve(data);
            else
                reject(new ApiError(xhr.status, data.error ?? '上传失败，请重试'));
        };
        xhr.onerror = () => reject(new ApiError(0, '网络中断，上传失败'));
        xhr.onabort = () => reject(new UploadCancelled());
    });
    xhr.open('POST', path);
    xhr.send(body);
    return { done, cancel: () => xhr.abort() };
}
export function uploadFile(file, to, onProgress) {
    return uploadBinary(`/api/files?${new URLSearchParams({ to, name: file.name })}`, file, onProgress);
}
export const uploadAvatar = (image) => uploadBinary('/api/me/avatar', image).done;
export const uploadSticker = (image, name) => uploadBinary(`/api/stickers?${new URLSearchParams({ name })}`, image).done;
