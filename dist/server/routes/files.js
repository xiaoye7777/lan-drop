// 文件上传、下载、图片预览，以及存储空间管理（查看占用、清理文件）
import { closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ID, isAdmin } from '../context.js';
import { contentDisposition, declaredLength, HttpError, imageHeaders, sendJson, stripInvisible } from '../http.js';
import { IMAGE_HEAD_BYTES, inspectImage } from '../images.js';
const MAX_FILE_NAME_LENGTH = 200;
/** 文件名来自用户输入：去掉路径和不可见字符，只保留可以显示的部分 */
function cleanFileName(value) {
    const base = (value ?? '').split(/[\\/]/).pop() ?? '';
    return [...stripInvisible(base)].slice(0, MAX_FILE_NAME_LENGTH).join('') || '未命名文件';
}
/** 读文件开头一段，判断它是不是可以预览的图片 */
function detectImage(path, size) {
    const head = Buffer.alloc(Math.min(size, IMAGE_HEAD_BYTES));
    const fd = openSync(path, 'r');
    try {
        readSync(fd, head, 0, head.length, 0);
    }
    finally {
        closeSync(fd);
    }
    return inspectImage(head);
}
export function fileRoutes(ctx) {
    const { config, store } = ctx;
    /** 上传文件。请求体就是文件的原始字节，接收人和文件名放在查询参数里 */
    async function upload(req, res, { url }) {
        const user = ctx.requireUser(req);
        const to = url.searchParams.get('to') ?? '';
        if (!store.isValidRecipient(to))
            throw new HttpError(400, '找不到接收人');
        const size = declaredLength(req, config.maxFileBytes);
        const refused = store.reserveStorage(size);
        if (refused)
            throw new HttpError(507, refused);
        const tempPath = store.newTempFilePath();
        try {
            await pipeline(req, createWriteStream(tempPath, { mode: 0o600 }));
            const image = detectImage(tempPath, size)?.type;
            const fileId = randomUUID();
            // 改名和写入消息在同一轮同步代码里完成，定期清理不会把这个文件当成残留删掉
            renameSync(tempPath, store.filePath(fileId));
            const message = store.addMessage(user, to, {
                file: {
                    id: fileId,
                    name: cleanFileName(url.searchParams.get('name')),
                    size,
                    owner: user.id,
                    ...(image ? { image } : {}),
                },
            });
            ctx.publish(message);
            sendJson(res, 200, message);
        }
        catch (error) {
            // 对方取消上传或网络中断时，清掉传了一半的文件
            rmSync(tempPath, { force: true });
            throw error;
        }
        finally {
            store.releaseStorage(size);
        }
    }
    /** 找到当前用户有权访问的文件 */
    function accessibleFile(req, fileId) {
        const user = ctx.requireUser(req);
        const file = store.accessibleFile(fileId, user.id);
        // 没有权限、不存在、已清理，返回同样的结果，不暴露文件是否存在
        if (!file)
            throw new HttpError(404, '文件不存在或已被清理');
        return file;
    }
    /**
     * 下载文件。一律按附件下载，并声明为二进制内容：
     * 否则有人上传一个 HTML，浏览器可能直接执行里面的脚本。
     */
    async function download(req, res, { match }) {
        const file = accessibleFile(req, match[1]);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': file.size,
            'Content-Disposition': contentDisposition('attachment', file.name),
            'Cache-Control': 'no-store',
        });
        await pipeline(createReadStream(store.filePath(file.id)), res);
    }
    /** 图片预览。只有上传时识别为图片的文件才能走这里，并按识别出的格式返回 */
    async function preview(req, res, { match }) {
        const file = accessibleFile(req, match[1]);
        if (!file.image)
            throw new HttpError(404, '这个文件不能预览');
        // 允许当前浏览器缓存：消息列表每次重画都会重新创建图片，不缓存的话每来一条消息就要把所有照片重新下载一遍。
        // 文件 id 唯一、内容不会变；private 表示只存在同事自己的浏览器里，不会被中间的代理缓存
        res.writeHead(200, imageHeaders(file.image, file.size, 'private, max-age=86400'));
        await pipeline(createReadStream(store.filePath(file.id)), res);
    }
    /** 存储空间：总占用，以及能看到的文件列表（从大到小） */
    function listStorage(req, res) {
        const user = ctx.requireUser(req);
        sendJson(res, 200, { storage: store.storageInfo(), files: store.listFiles(user.id, isAdmin(req, config)) });
    }
    /**
     * 清理文件：上传者本人可以清理，在服务器电脑上用 localhost 打开的人可以清理任何文件。
     * 文件从磁盘删除，消息保留并显示“已清理”
     */
    function removeFile(req, res, { match }) {
        const user = ctx.requireUser(req);
        const admin = isAdmin(req, config);
        const owner = store.fileOwner(match[1]);
        if (!owner || (!admin && !store.accessibleFile(match[1], user.id)))
            throw new HttpError(404, '文件不存在或已被清理');
        if (!admin && owner !== user.id)
            throw new HttpError(403, '只能清理自己上传的文件');
        store.removeFile(match[1]).forEach(ctx.publish);
        sendJson(res, 200, { ok: true });
    }
    return [
        { method: 'POST', path: '/api/files', handler: upload },
        { method: 'GET', path: new RegExp(`^/api/files/${ID}$`), handler: download },
        { method: 'GET', path: new RegExp(`^/api/files/${ID}/preview$`), handler: preview },
        { method: 'POST', path: new RegExp(`^/api/files/${ID}/delete$`), handler: removeFile },
        { method: 'GET', path: '/api/storage', handler: listStorage },
    ];
}
