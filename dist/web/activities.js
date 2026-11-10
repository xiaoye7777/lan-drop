// 投票、接龙、大转盘、五子棋：消息卡片的显示，以及发起时的弹窗
import { LIMITS } from '../shared/catalog.js';
import * as api from './api.js';
import { h, openDialog, prefersReducedMotion, promptText } from './dom.js';
import { animationElapsed, applyMessage, GROUP, handleError, state, userById } from './state.js';
export const WHEEL_SPIN_MS = 4200;
const SIZE = LIMITS.gomokuSize;
const WHEEL_COLORS = ['#0e6e78', '#e76f51', '#2a9d8f', '#f4a261', '#6a4c93', '#e9c46a', '#3d5a80', '#d62869'];
async function run(request) {
    try {
        applyMessage(await request);
    }
    catch (error) {
        handleError(error);
    }
}
const nameOf = (id) => userById(id)?.name ?? '已离开的同事';
function card(kind, label, subtitle, ...children) {
    return h('div', { className: `card activity activity-${kind}` }, h('div', { className: 'card-head' }, h('span', { className: 'card-tag' }, label), h('span', { className: 'card-sub' }, subtitle)), ...children);
}
const smallButton = (label, onclick, extra = '') => h('button', { className: `btn btn-ghost btn-small ${extra}`, type: 'button', onclick }, label);
// ---------- 投票 ----------
export function renderPoll(message) {
    const poll = message.poll;
    const meId = state.me?.id ?? '';
    const mine = poll.votes[meId] ?? [];
    const voters = Object.entries(poll.votes);
    const choose = (index) => {
        let choices;
        if (poll.multi)
            choices = mine.includes(index) ? mine.filter((item) => item !== index) : [...mine, index];
        else
            choices = mine.includes(index) ? [] : [index];
        void run(api.act(message.id, { type: 'vote', choices }));
    };
    const options = poll.options.map((option, index) => {
        const names = voters.filter(([, choices]) => choices.includes(index)).map(([id]) => nameOf(id));
        const percent = voters.length ? Math.round((names.length / voters.length) * 100) : 0;
        const fill = h('span', { className: 'poll-fill' });
        fill.style.width = `${percent}%`;
        return h('li', {}, h('button', {
            className: mine.includes(index) ? 'poll-option voted' : 'poll-option',
            type: 'button',
            disabled: poll.closed,
            'aria-pressed': String(mine.includes(index)),
            onclick: () => choose(index),
        }, fill, h('span', { className: 'poll-label' }, mine.includes(index) ? `✓ ${option}` : option), h('span', { className: 'poll-count' }, `${names.length} 票 · ${percent}%`)), names.length > 0 && h('div', { className: 'poll-voters' }, names.join('、')));
    });
    return card('poll', '投票', `${poll.multi ? '多选' : '单选'} · 实名${poll.closed ? ' · 已结束' : ''}`, h('div', { className: 'card-title' }, poll.question), h('ul', { className: 'poll-options' }, ...options), h('div', { className: 'card-foot' }, h('span', {}, `${voters.length} 人已投${poll.closed ? '' : '，再点一次可以取消'}`), !poll.closed && message.from === meId && smallButton('结束投票', () => void run(api.act(message.id, { type: 'close' })))));
}
export function openPollDialog(to) {
    const question = h('input', { className: 'input', maxLength: LIMITS.pollQuestionLength, required: true, placeholder: '比如：周五团建去哪？' });
    const list = h('div', { className: 'option-list' });
    const multi = h('input', { type: 'checkbox' });
    const error = h('p', { className: 'form-error', hidden: true });
    const addOption = (value = '') => {
        if (list.children.length >= LIMITS.pollMaxOptions)
            return;
        const row = h('div', { className: 'option-row' }, h('input', { className: 'input', maxLength: LIMITS.optionLength, value, placeholder: `选项 ${list.children.length + 1}` }), h('button', {
            className: 'icon-btn',
            type: 'button',
            'aria-label': '删除这个选项',
            textContent: '×',
            onclick: () => {
                if (list.children.length > 2)
                    row.remove();
            },
        }));
        list.append(row);
    };
    addOption();
    addOption();
    const dialog = openDialog('dialog-form', h('form', {
        onsubmit: async (event) => {
            event.preventDefault();
            const options = [...list.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
            try {
                applyMessage(await api.sendMessage(to, { poll: { question: question.value, options, multi: multi.checked } }));
                dialog.close();
            }
            catch (err) {
                error.textContent = err instanceof Error ? err.message : '发起失败';
                error.hidden = false;
            }
        },
    }, h('h2', {}, '发起投票'), h('label', { className: 'field' }, h('span', {}, '问题'), question), h('div', { className: 'field' }, h('span', {}, '选项'), list), h('button', { className: 'btn btn-ghost btn-small', type: 'button', onclick: () => addOption() }, '＋ 添加选项'), h('label', { className: 'check' }, multi, '允许多选'), h('p', { className: 'dialog-note' }, '投票是实名的，大家能看到谁投了什么。'), error, h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'), h('button', { className: 'btn btn-primary', type: 'submit' }, '发起'))));
    question.focus();
}
// ---------- 接龙 ----------
export function renderRelay(message) {
    const relay = message.relay;
    const meId = state.me?.id ?? '';
    const mine = relay.entries.find((entry) => entry.userId === meId);
    const join = async () => {
        const text = await promptText(mine ? '修改我的接龙' : '接龙', {
            placeholder: '比如：张三 1 份',
            value: mine?.text ?? state.me?.name ?? '',
            maxLength: LIMITS.relayEntryLength,
        });
        if (text)
            await run(api.act(message.id, { type: 'join', text }));
    };
    return card('relay', '接龙', relay.closed ? '已结束' : `${relay.entries.length} 人已接龙`, h('div', { className: 'card-title' }, relay.title), relay.entries.length > 0
        ? h('ol', { className: 'relay-list' }, ...relay.entries.map((entry) => h('li', { className: entry.userId === meId ? 'mine' : '' }, h('span', { className: 'relay-text' }, entry.text), entry.userId === meId &&
            !relay.closed &&
            smallButton('撤回', () => void run(api.act(message.id, { type: 'leave' })), 'btn-link'))))
        : h('p', { className: 'card-empty' }, '还没有人接龙'), !relay.closed &&
        h('div', { className: 'card-foot' }, h('button', { className: 'btn btn-primary btn-small', type: 'button', onclick: () => void join() }, mine ? '修改我的' : '我要接龙'), message.from === meId && smallButton('结束接龙', () => void run(api.act(message.id, { type: 'close' })))));
}
export function openRelayDialog(to) {
    const title = h('input', { className: 'input', maxLength: LIMITS.relayTitleLength, required: true, placeholder: '比如：明天午饭订餐' });
    const first = h('input', { className: 'input', maxLength: LIMITS.relayEntryLength, placeholder: '可以不填' });
    const error = h('p', { className: 'form-error', hidden: true });
    const dialog = openDialog('dialog-form', h('form', {
        onsubmit: async (event) => {
            event.preventDefault();
            try {
                applyMessage(await api.sendMessage(to, { relay: { title: title.value, first: first.value } }));
                dialog.close();
            }
            catch (err) {
                error.textContent = err instanceof Error ? err.message : '发起失败';
                error.hidden = false;
            }
        },
    }, h('h2', {}, '发起接龙'), h('label', { className: 'field' }, h('span', {}, '主题'), title), h('label', { className: 'field' }, h('span', {}, '我的第一条'), first), error, h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'), h('button', { className: 'btn btn-primary', type: 'submit' }, '发起'))));
    title.focus();
}
// ---------- 大转盘 ----------
function drawWheel(options, size) {
    const canvas = h('canvas', { className: 'wheel-canvas', width: size * devicePixelRatio, height: size * devicePixelRatio });
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return canvas;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const r = size / 2;
    const segment = (Math.PI * 2) / options.length;
    options.forEach((option, index) => {
        // 从正上方开始，顺时针排列
        const start = -Math.PI / 2 + index * segment;
        ctx.beginPath();
        ctx.moveTo(r, r);
        ctx.arc(r, r, r - 2, start, start + segment);
        ctx.closePath();
        ctx.fillStyle = WHEEL_COLORS[index % WHEEL_COLORS.length];
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.save();
        ctx.translate(r, r);
        ctx.rotate(start + segment / 2);
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${options.length > 12 ? 10 : 12}px sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const label = [...option].length > 6 ? `${[...option].slice(0, 6).join('')}…` : option;
        ctx.fillText(label, r - 12, 0);
        ctx.restore();
    });
    ctx.beginPath();
    ctx.arc(r, r, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    return canvas;
}
export function renderWheel(message) {
    const wheel = message.wheel;
    const segmentDeg = 360 / wheel.options.length;
    // 顺时针转动后，让结果那一格的中线停在正上方的指针下面；前面多转 5 圈
    const finalDeg = 360 * 5 + (360 - (wheel.result + 0.5) * segmentDeg);
    const elapsed = prefersReducedMotion() ? null : animationElapsed(message.id, WHEEL_SPIN_MS);
    const winner = wheel.options[wheel.result];
    const disc = h('div', { className: 'wheel-disc' }, drawWheel(wheel.options, 220));
    disc.style.setProperty('--spin-to', `${finalDeg}deg`);
    const result = h('div', { className: 'wheel-result' }, `🎉 结果：${winner}`);
    if (elapsed !== null) {
        // 列表重画时接着转，不从头开始
        disc.classList.add('spinning');
        disc.style.animationDelay = `-${elapsed}ms`;
        result.textContent = '转动中…';
        window.setTimeout(() => {
            result.textContent = `🎉 结果：${winner}`;
        }, WHEEL_SPIN_MS - elapsed);
    }
    return card('wheel', '大转盘', `${wheel.options.length} 个选项 · 服务器抽取`, h('div', { className: 'card-title' }, wheel.title), h('div', { className: 'wheel' }, h('div', { className: 'wheel-pointer', 'aria-hidden': 'true' }), disc), result);
}
export function openWheelDialog(to) {
    const title = h('input', { className: 'input', maxLength: LIMITS.wheelTitleLength, required: true, placeholder: '比如：今天谁去拿外卖' });
    const options = h('textarea', { className: 'input', rows: 6, placeholder: '一行一个选项，2 到 20 个' });
    const error = h('p', { className: 'form-error', hidden: true });
    const fill = (onlineOnly) => {
        const members = to === GROUP ? state.users : state.users.filter((user) => user.id === to || user.id === state.me?.id);
        options.value = members
            .filter((user) => !onlineOnly || user.online)
            .map((user) => user.name)
            .join('\n');
    };
    const dialog = openDialog('dialog-form', h('form', {
        onsubmit: async (event) => {
            event.preventDefault();
            const list = options.value.split('\n').map((line) => line.trim()).filter(Boolean);
            try {
                applyMessage(await api.sendMessage(to, { wheel: { title: title.value, options: list } }));
                dialog.close();
            }
            catch (err) {
                error.textContent = err instanceof Error ? err.message : '发起失败';
                error.hidden = false;
            }
        },
    }, h('h2', {}, '大转盘'), h('label', { className: 'field' }, h('span', {}, '主题'), title), h('label', { className: 'field' }, h('span', {}, '选项'), options), h('div', { className: 'inline-actions' }, smallButton('填入全部同事', () => fill(false)), smallButton('只填在线的', () => fill(true))), h('p', { className: 'dialog-note' }, '结果由服务器随机抽取，发起人也没法提前知道。'), error, h('div', { className: 'dialog-actions' }, h('span', { className: 'spacer' }), h('button', { className: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, '取消'), h('button', { className: 'btn btn-primary', type: 'submit' }, '开转'))));
    title.focus();
}
// ---------- 五子棋 ----------
export function renderGomoku(message) {
    const game = message.gomoku;
    const meId = state.me?.id ?? '';
    const stones = new Map(game.moves.map((cell, index) => [cell, index % 2 === 0 ? 'black' : 'white']));
    const lastMove = game.moves.at(-1);
    const turnId = game.moves.length % 2 === 0 ? game.black : game.white;
    const myTurn = !game.finished && game.white !== null && turnId === meId;
    const isPlayer = meId === game.black || meId === game.white;
    const canJoin = !game.finished && !game.white && meId !== game.black && (message.to === GROUP || message.to === meId);
    const black = `⚫ ${game.blackName}`;
    const white = game.whiteName ? `⚪ ${game.whiteName}` : '⚪ 等待应战';
    let status;
    if (game.finished) {
        if (game.winner === null)
            status = '对局已取消';
        else if (game.winner === 'draw')
            status = '平局';
        else
            status = `${game.winner === 'black' ? black : white} 获胜！${game.resignedBy ? '（对方认输）' : ''}`;
    }
    else if (!game.white) {
        status = '等待有人应战';
    }
    else {
        status = myTurn ? '轮到你了' : `轮到 ${turnId === game.black ? black : white}`;
    }
    const board = h('div', { className: myTurn ? 'gomoku-board my-turn' : 'gomoku-board', role: 'group', 'aria-label': '棋盘' });
    for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
        const stone = stones.get(cell);
        const row = Math.floor(cell / SIZE) + 1;
        const col = (cell % SIZE) + 1;
        board.append(h('button', {
            className: `gomoku-cell${stone ? ` stone-${stone}` : ''}${cell === lastMove ? ' last' : ''}`,
            type: 'button',
            disabled: !myTurn || stone !== undefined,
            'aria-label': `第 ${row} 行第 ${col} 列${stone ? (stone === 'black' ? '，黑子' : '，白子') : ''}`,
            onclick: () => void run(api.act(message.id, { type: 'move', cell })),
        }, h('span', { className: 'stone' })));
    }
    return card('gomoku', '五子棋', `${black} vs ${white}`, h('div', { className: game.finished ? 'gomoku-status finished' : 'gomoku-status' }, status), board, (canJoin || (isPlayer && !game.finished)) &&
        h('div', { className: 'card-foot' }, canJoin && h('button', { className: 'btn btn-primary btn-small', type: 'button', onclick: () => void run(api.act(message.id, { type: 'join' })) }, '应战'), isPlayer &&
            !game.finished &&
            smallButton(game.white ? '认输' : '取消对局', () => void run(api.act(message.id, { type: 'resign' })))));
}
export function startGomoku(to) {
    void run(api.sendMessage(to, { gomoku: {} }));
}
