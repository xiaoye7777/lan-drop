// 个人资料、头像和全组共享的自定义表情
import { readFileSync } from 'node:fs';
import { BUBBLE_IDS, LIMITS, NAMEPLATE_IDS } from '../../shared/catalog.js';
import { AVATAR_MAX_BYTES, STICKER_MAX_BYTES } from '../config.js';
import { ID } from '../context.js';
import { cleanLine, declaredLength, HttpError, imageHeaders, readBody, readJson, sendJson } from '../http.js';
import { inspectImage } from '../images.js';
import { assertNameAvailable } from './auth.js';
const STICKERS_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** 头像和表情的地址里带了版本号或固定 id，内容不会变，可以让浏览器缓存 */
const IMAGE_CACHE = 'private, max-age=604800, immutable';
export function profileRoutes(ctx) {
    const { store } = ctx;
    /** 读取上传的小图片，确认确实是允许的图片格式 */
    async function readImage(req, maxBytes) {
        declaredLength(req, maxBytes);
        const data = await readBody(req);
        const info = inspectImage(data);
        if (!info)
            throw new HttpError(415, '只支持 PNG、JPEG、GIF、WebP 图片，且尺寸不能过大');
        return { data, info };
    }
    async function updateProfile(req, res) {
        const user = ctx.requireUser(req);
        const body = await readJson(req);
        const patch = {};
        if (body.name !== undefined) {
            patch.name = cleanLine(body.name, LIMITS.nameLength, '昵称');
            assertNameAvailable(ctx, patch.name, user.id);
        }
        if (body.bio !== undefined)
            patch.bio = cleanLine(body.bio, LIMITS.bioLength, '签名', true);
        if (body.nudgeSuffix !== undefined) {
            patch.nudgeSuffix = cleanLine(body.nudgeSuffix, LIMITS.nudgeSuffixLength, '拍一拍后缀', true);
        }
        // 样式只能从内置列表里选，浏览器拿到的永远是已知的 id
        if (body.nameplate !== undefined) {
            if (typeof body.nameplate !== 'string' || !NAMEPLATE_IDS.has(body.nameplate)) {
                throw new HttpError(400, '没有这个名片背景');
            }
            patch.nameplate = body.nameplate;
        }
        if (body.bubble !== undefined) {
            if (typeof body.bubble !== 'string' || !BUBBLE_IDS.has(body.bubble))
                throw new HttpError(400, '没有这个气泡样式');
            patch.bubble = body.bubble;
        }
        store.updateProfile(user, patch);
        ctx.broadcastUsers();
        sendJson(res, 200, ctx.toUserInfo(user));
    }
    /** 给同事设置备注，只有自己能看到。备注为空表示清除 */
    async function setRemark(req, res) {
        const user = ctx.requireUser(req);
        const body = await readJson(req);
        const target = typeof body.userId === 'string' ? store.getUser(body.userId) : undefined;
        if (!target || target.id === user.id)
            throw new HttpError(400, '找不到这位同事');
        store.setRemark(user, target.id, cleanLine(body.remark, LIMITS.remarkLength, '备注', true));
        const remarks = user.remarks ?? {};
        // 同一个人开着的其他标签页也同步更新
        ctx.hub.sendTo([user.id], { type: 'remarks', remarks });
        sendJson(res, 200, { remarks });
    }
    async function uploadAvatar(req, res) {
        const user = ctx.requireUser(req);
        ctx.requireStorage();
        const { data, info } = await readImage(req, AVATAR_MAX_BYTES);
        store.setAvatar(user, info.type, data);
        ctx.broadcastUsers();
        sendJson(res, 200, ctx.toUserInfo(user));
    }
    function deleteAvatar(req, res) {
        const user = ctx.requireUser(req);
        store.removeAvatar(user);
        ctx.broadcastUsers();
        sendJson(res, 200, ctx.toUserInfo(user));
    }
    function getAvatar(req, res, { match }) {
        ctx.requireUser(req);
        const owner = store.getUser(match[1]);
        if (!owner?.avatar)
            throw new HttpError(404, '没有头像');
        const data = readFileSync(store.avatarPath(owner.id));
        res.writeHead(200, imageHeaders(owner.avatar.type, data.length, IMAGE_CACHE));
        res.end(data);
    }
    async function uploadSticker(req, res, { url }) {
        const user = ctx.requireUser(req);
        ctx.requireStorage();
        const stickers = store.listStickers();
        if (stickers.length >= LIMITS.maxCustomStickers)
            throw new HttpError(507, '表情库已满，先删掉一些吧');
        const name = cleanLine(url.searchParams.get('name') ?? '', LIMITS.stickerNameLength, '表情名称', true) || '表情';
        const { data, info } = await readImage(req, STICKER_MAX_BYTES);
        const total = stickers.reduce((sum, sticker) => sum + sticker.size, 0);
        if (total + data.length > STICKERS_MAX_TOTAL_BYTES)
            throw new HttpError(507, '表情库空间已满，先删掉一些吧');
        const sticker = store.addSticker(user, name, info.type, data);
        ctx.broadcastStickers();
        sendJson(res, 200, sticker);
    }
    function getSticker(req, res, { match }) {
        ctx.requireUser(req);
        const sticker = store.findSticker(match[1]);
        if (!sticker)
            throw new HttpError(404, '表情不存在');
        const data = readFileSync(store.stickerPath(sticker.id));
        res.writeHead(200, imageHeaders(sticker.type, data.length, IMAGE_CACHE));
        res.end(data);
    }
    function deleteSticker(req, res, { match }) {
        const user = ctx.requireUser(req);
        const sticker = store.findSticker(match[1]);
        if (!sticker)
            throw new HttpError(404, '表情不存在');
        if (sticker.owner !== user.id)
            throw new HttpError(403, '只能删除自己添加的表情');
        store.removeSticker(sticker.id);
        ctx.broadcastStickers();
        sendJson(res, 200, { ok: true });
    }
    return [
        { method: 'POST', path: '/api/me', handler: updateProfile },
        { method: 'POST', path: '/api/remarks', handler: setRemark },
        { method: 'POST', path: '/api/me/avatar', handler: uploadAvatar },
        { method: 'POST', path: '/api/me/avatar/delete', handler: deleteAvatar },
        { method: 'GET', path: new RegExp(`^/api/avatars/${ID}$`), handler: getAvatar },
        { method: 'POST', path: '/api/stickers', handler: uploadSticker },
        { method: 'GET', path: new RegExp(`^/api/stickers/${ID}$`), handler: getSticker },
        { method: 'POST', path: new RegExp(`^/api/stickers/${ID}/delete$`), handler: deleteSticker },
    ];
}
