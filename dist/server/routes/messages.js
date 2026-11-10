import { BUILTIN_STICKERS, EFFECT_IDS, LIMITS } from '../../shared/catalog.js';
import { applyAction, createGomoku, createPoll, createRelay, createWheel } from '../activities.js';
import { ID } from '../context.js';
import { HttpError, readJson, sendJson } from '../http.js';
export function messageRoutes(ctx) {
    const { store } = ctx;
    /** 请求体里只能有一种内容，根据它构造消息内容并校验 */
    function buildContent(body, user) {
        const kinds = ['text', 'sticker', 'poll', 'relay', 'wheel', 'gomoku'].filter((key) => body[key] !== undefined);
        if (kinds.length !== 1)
            throw new HttpError(400, '请求格式不正确');
        switch (kinds[0]) {
            case 'text': {
                const text = typeof body.text === 'string' ? body.text.trim() : '';
                if (!text)
                    throw new HttpError(400, '消息不能为空');
                if (text.length > LIMITS.textLength)
                    throw new HttpError(400, `消息不能超过 ${LIMITS.textLength} 个字`);
                if (body.effect === undefined)
                    return { text };
                if (typeof body.effect !== 'string' || !EFFECT_IDS.has(body.effect))
                    throw new HttpError(400, '没有这个特效');
                return { text, effect: body.effect };
            }
            case 'sticker': {
                const ref = body.sticker;
                const id = typeof ref?.id === 'string' ? ref.id : '';
                if (ref?.source === 'builtin' && BUILTIN_STICKERS.has(id))
                    return { sticker: { source: 'builtin', id } };
                if (ref?.source === 'custom' && store.findSticker(id))
                    return { sticker: { source: 'custom', id } };
                throw new HttpError(400, '表情不存在');
            }
            case 'poll':
                return { poll: createPoll(body.poll) };
            case 'relay':
                return { relay: createRelay(body.relay, user) };
            case 'wheel':
                return { wheel: createWheel(body.wheel) };
            default:
                return { gomoku: createGomoku(user) };
        }
    }
    /** 找到当前用户能看到的消息。看不到的和不存在的返回同样的结果，不暴露消息是否存在 */
    function visibleMessage(user, id) {
        const message = store.findMessage(id);
        if (!message || !store.canView(message, user.id))
            throw new HttpError(404, '消息不存在');
        return message;
    }
    async function postMessage(req, res) {
        const user = ctx.requireUser(req);
        const body = await readJson(req);
        const to = typeof body.to === 'string' ? body.to : '';
        if (!store.isValidRecipient(to))
            throw new HttpError(400, '找不到接收人');
        const message = store.addMessage(user, to, buildContent(body, user));
        ctx.publish(message);
        sendJson(res, 200, message);
    }
    async function act(req, res, { match }) {
        const user = ctx.requireUser(req);
        const message = visibleMessage(user, match[1]);
        applyAction(message, user, await readJson(req));
        store.saveMessageChange();
        ctx.publish(message);
        sendJson(res, 200, message);
    }
    /** 撤回：只能撤回自己发的，不限时间，服务器上永久删除（带文件的连文件一起删） */
    function recall(req, res, { match }) {
        const user = ctx.requireUser(req);
        const message = visibleMessage(user, match[1]);
        if (message.from !== user.id)
            throw new HttpError(403, '只能撤回自己发的消息');
        store.deleteMessage(message);
        ctx.publishDeleted(message);
        sendJson(res, 200, { ok: true });
    }
    return [
        { method: 'POST', path: '/api/messages', handler: postMessage },
        { method: 'POST', path: new RegExp(`^/api/messages/${ID}/actions$`), handler: act },
        { method: 'POST', path: new RegExp(`^/api/messages/${ID}/recall$`), handler: recall },
    ];
}
