// 投票、接龙、大转盘、五子棋的规则。
// 这些消息发出后状态还会变化，所有变化都在服务器上校验，浏览器只负责显示和提交操作。
import { randomInt } from 'node:crypto';
import { LIMITS } from '../shared/catalog.js';
import { cleanLine, HttpError } from './http.js';
const SIZE = LIMITS.gomokuSize;
function asObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new HttpError(400, '请求格式不正确');
    return value;
}
/** 清理选项列表：去掉空白项，检查数量、长度和重复 */
function cleanOptions(value, min, max, maxLength) {
    if (!Array.isArray(value))
        throw new HttpError(400, '选项格式不正确');
    const options = value
        .map((item) => (typeof item === 'string' ? item : ''))
        .map((item) => item.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
        .filter(Boolean);
    if (options.length < min)
        throw new HttpError(400, `至少需要 ${min} 个选项`);
    if (options.length > max)
        throw new HttpError(400, `最多 ${max} 个选项`);
    if (options.some((option) => [...option].length > maxLength)) {
        throw new HttpError(400, `每个选项不能超过 ${maxLength} 个字`);
    }
    if (new Set(options).size !== options.length)
        throw new HttpError(400, '选项不能重复');
    return options;
}
// ---------- 创建 ----------
export function createPoll(input) {
    const body = asObject(input);
    return {
        question: cleanLine(body.question, LIMITS.pollQuestionLength, '投票问题'),
        options: cleanOptions(body.options, 2, LIMITS.pollMaxOptions, LIMITS.optionLength),
        multi: body.multi === true,
        votes: {},
        closed: false,
    };
}
export function createRelay(input, user) {
    const body = asObject(input);
    const first = cleanLine(body.first, LIMITS.relayEntryLength, '接龙内容', true);
    return {
        title: cleanLine(body.title, LIMITS.relayTitleLength, '接龙主题'),
        entries: first ? [{ userId: user.id, name: user.name, text: first }] : [],
        closed: false,
    };
}
/** 结果用加密级随机数在服务器上抽，发起人也没法提前知道或操纵 */
export function createWheel(input) {
    const body = asObject(input);
    const options = cleanOptions(body.options, 2, LIMITS.wheelMaxOptions, LIMITS.wheelOptionLength);
    return {
        title: cleanLine(body.title, LIMITS.wheelTitleLength, '转盘主题'),
        options,
        result: randomInt(options.length),
    };
}
export function createGomoku(user) {
    return {
        black: user.id,
        blackName: user.name,
        white: null,
        whiteName: null,
        moves: [],
        finished: false,
        winner: null,
    };
}
// ---------- 五子棋判定 ----------
/** 刚落下的这颗子，在横、竖、两条斜线上有没有连成五个或更多 */
export function makesFive(moves, cell) {
    // 同一方的棋子：和最后一手奇偶相同的那些
    const parity = (moves.length - 1) % 2;
    const mine = new Set(moves.filter((_, index) => index % 2 === parity));
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;
    const countDirection = (dr, dc) => {
        let count = 0;
        for (let r = row + dr, c = col + dc; r >= 0 && r < SIZE && c >= 0 && c < SIZE; r += dr, c += dc) {
            if (!mine.has(r * SIZE + c))
                break;
            count += 1;
        }
        return count;
    };
    return [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
    ].some(([dr, dc]) => 1 + countDirection(dr, dc) + countDirection(-dr, -dc) >= 5);
}
// ---------- 操作 ----------
/**
 * 对投票、接龙、五子棋消息执行一个操作，直接修改 message。
 * 调用前已经确认操作人能看到这条消息。
 */
export function applyAction(message, user, input) {
    const action = asObject(input);
    const type = action.type;
    if (message.poll) {
        const poll = message.poll;
        if (type === 'close') {
            if (message.from !== user.id)
                throw new HttpError(403, '只有发起人可以结束投票');
            poll.closed = true;
            return;
        }
        if (type !== 'vote')
            throw new HttpError(400, '不支持的操作');
        if (poll.closed)
            throw new HttpError(409, '投票已经结束');
        const choices = action.choices;
        if (!Array.isArray(choices) || !choices.every((item) => Number.isInteger(item))) {
            throw new HttpError(400, '选项格式不正确');
        }
        const unique = [...new Set(choices)].sort((a, b) => a - b);
        if (unique.some((index) => index < 0 || index >= poll.options.length))
            throw new HttpError(400, '选项不存在');
        if (!poll.multi && unique.length > 1)
            throw new HttpError(400, '这是单选投票');
        // 空数组表示撤回投票
        if (unique.length === 0)
            delete poll.votes[user.id];
        else
            poll.votes[user.id] = unique;
        return;
    }
    if (message.relay) {
        const relay = message.relay;
        if (type === 'close') {
            if (message.from !== user.id)
                throw new HttpError(403, '只有发起人可以结束接龙');
            relay.closed = true;
            return;
        }
        if (relay.closed)
            throw new HttpError(409, '接龙已经结束');
        const existing = relay.entries.find((entry) => entry.userId === user.id);
        if (type === 'leave') {
            relay.entries = relay.entries.filter((entry) => entry.userId !== user.id);
            return;
        }
        if (type !== 'join')
            throw new HttpError(400, '不支持的操作');
        const text = cleanLine(action.text, LIMITS.relayEntryLength, '接龙内容');
        if (existing) {
            existing.text = text;
            existing.name = user.name;
        }
        else {
            if (relay.entries.length >= LIMITS.relayMaxEntries)
                throw new HttpError(409, '接龙人数已满');
            relay.entries.push({ userId: user.id, name: user.name, text });
        }
        return;
    }
    if (message.gomoku) {
        applyGomoku(message, message.gomoku, user, type, action);
        return;
    }
    throw new HttpError(400, '这条消息不支持操作');
}
function applyGomoku(message, game, user, type, action) {
    if (game.finished)
        throw new HttpError(409, '对局已经结束');
    if (type === 'join') {
        if (game.white)
            throw new HttpError(409, '已经有人应战了');
        if (user.id === game.black)
            throw new HttpError(409, '不能和自己下棋');
        // 私聊里的对局只有对方能应战；全组的对局谁都可以
        if (message.to !== 'all' && message.to !== user.id)
            throw new HttpError(403, '你不能加入这局');
        game.white = user.id;
        game.whiteName = user.name;
        return;
    }
    if (type === 'resign') {
        if (user.id !== game.black && user.id !== game.white)
            throw new HttpError(403, '你不在这局里');
        game.finished = true;
        game.resignedBy = user.id;
        // 还没人应战时认输等于取消，不算谁赢
        game.winner = game.white ? (user.id === game.black ? 'white' : 'black') : null;
        return;
    }
    if (type !== 'move')
        throw new HttpError(400, '不支持的操作');
    if (!game.white)
        throw new HttpError(409, '还在等待对手');
    const turn = game.moves.length % 2 === 0 ? game.black : game.white;
    if (user.id !== turn)
        throw new HttpError(409, '还没轮到你');
    const cell = action.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= SIZE * SIZE) {
        throw new HttpError(400, '落子位置不正确');
    }
    if (game.moves.includes(cell))
        throw new HttpError(409, '这里已经有棋子了');
    game.moves.push(cell);
    if (makesFive(game.moves, cell)) {
        game.finished = true;
        game.winner = game.moves.length % 2 === 1 ? 'black' : 'white';
    }
    else if (game.moves.length === SIZE * SIZE) {
        game.finished = true;
        game.winner = 'draw';
    }
}
