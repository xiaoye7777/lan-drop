// 第三批功能的集成测试：引用回复、@、转发、拍一拍、备注、存储空间、历史消息分页、搜索、旧数据升级。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODE, login, MB, myId, postJson, send, session, start, subscribe, upload, wait } from './helpers.js';
async function json(res) {
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json());
}
const get = (base, path, cookie) => fetch(base + path, { headers: { Cookie: cookie } });
// ---------- 引用回复和 @ ----------
test('引用回复：摘要由服务器生成，只能引用同一会话的消息；原消息撤回后引用内容被清空', async () => {
    const { app, base, dataDir } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const bId = await myId(base, b);
    const original = await send(base, a, { to: 'all', text: '原话-被引用的内容' });
    const privateMessage = await send(base, a, { to: bId, text: '私聊里的话' });
    const reply = await send(base, b, { to: 'all', text: '我回复你', replyTo: original.id });
    assert.equal(reply.reply?.id, original.id);
    assert.equal(reply.reply?.summary, '原话-被引用的内容');
    // 私聊的消息不能在全组里引用，否则会把私聊内容泄露到群里
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', replyTo: privateMessage.id }, b)).status, 400);
    // 不存在的消息
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', replyTo: 'nope' }, b)).status, 404);
    const stream = await subscribe(base, b);
    assert.equal((await postJson(base, `/api/messages/${original.id}/recall`, {}, a)).status, 200);
    await wait(100);
    const updated = (await session(base, b)).messages.find((message) => message.id === reply.id);
    assert.equal(updated?.reply?.recalled, true);
    assert.equal(updated?.reply?.summary, '');
    assert.ok(stream.read().includes('"recalled":true'), '回复的更新会推送出去');
    stream.close();
    assert.ok(!readFileSync(join(dataDir, 'messages.jsonl'), 'utf8').includes('被引用的内容'), '磁盘上的快照也清掉了');
    await app.close();
});
test('@：只能 @ 存在的同事或所有人，只在全组消息里保留', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const bId = await myId(base, b);
    const message = await send(base, a, { to: 'all', text: '@B 看一下', mentions: [bId, 'all'] });
    assert.deepEqual(message.mentions, [bId, 'all']);
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', mentions: ['nobody'] }, a)).status, 400);
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x', mentions: 'all' }, a)).status, 400);
    const privateMessage = await send(base, a, { to: bId, text: '私聊', mentions: [bId] });
    assert.equal(privateMessage.mentions, undefined);
    await app.close();
});
// ---------- 转发 ----------
test('合并转发：收到的人能看内容和下载里面的文件，第三人不行；不能混选不同会话的消息', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const c = await login(base, 'C');
    const bId = await myId(base, b);
    const cId = await myId(base, c);
    const text = await send(base, a, { to: bId, text: '第一句' });
    const file = await json(await upload(base, b, await myId(base, a), '报告.txt', 'report-content'));
    const poll = await send(base, a, { to: bId, poll: { question: '吃什么', options: ['面', '饭'], multi: false } });
    const group = await send(base, a, { to: 'all', text: '全组的话' });
    // A 把和 B 的私聊转给 C
    const { messages } = await json(await postJson(base, '/api/forward', { ids: [poll.id, text.id, file.id], to: [cId], mode: 'merge' }, a));
    assert.equal(messages.length, 1);
    const bundle = messages[0].forward;
    assert.equal(bundle?.title, 'A和B的聊天记录');
    assert.deepEqual(bundle?.items.map((item) => item.text ?? item.file?.name ?? item.summary), ['第一句', '报告.txt', '[投票] 吃什么'], '按时间排序，投票只留一句说明');
    // C 能下载转发里的文件；D 不能
    const fileId = file.file?.id ?? '';
    assert.equal(await (await get(base, `/api/files/${fileId}`, c)).text(), 'report-content');
    const d = await login(base, 'D');
    assert.equal((await get(base, `/api/files/${fileId}`, d)).status, 404);
    // 不同会话的消息不能一起转发；看不到的消息不能转发
    assert.equal((await postJson(base, '/api/forward', { ids: [text.id, group.id], to: [cId], mode: 'merge' }, a)).status, 400);
    assert.equal((await postJson(base, '/api/forward', { ids: [text.id], to: [cId], mode: 'merge' }, d)).status, 404);
    // 投票不能逐条转发
    assert.equal((await postJson(base, '/api/forward', { ids: [poll.id], to: [cId], mode: 'single' }, a)).status, 400);
    await app.close();
});
test('逐条转发文件：原消息撤回后转发的那份还能下载，全部撤回后文件才从磁盘删除', async () => {
    const { app, base, dataDir } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const bId = await myId(base, b);
    const original = await json(await upload(base, a, 'all', 'a.txt', 'shared-file'));
    const fileId = original.file?.id ?? '';
    const { messages } = await json(await postJson(base, '/api/forward', { ids: [original.id], to: [bId, 'all'], mode: 'single' }, b));
    assert.equal(messages.length, 2);
    assert.equal(messages[0].from, (await session(base, b)).me.id);
    assert.equal(messages[0].file?.owner, (await session(base, a)).me.id, '文件仍然属于上传者');
    await postJson(base, `/api/messages/${original.id}/recall`, {}, a);
    assert.equal(await (await get(base, `/api/files/${fileId}`, b)).text(), 'shared-file');
    assert.ok(existsSync(join(dataDir, 'files', fileId)));
    for (const message of messages)
        await postJson(base, `/api/messages/${message.id}/recall`, {}, b);
    assert.ok(!existsSync(join(dataDir, 'files', fileId)));
    await app.close();
});
// ---------- 拍一拍和备注 ----------
test('拍一拍：带上对方设置的后缀；私聊里不能拍第三人；不能连续拍', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const c = await login(base, 'C');
    const bId = await myId(base, b);
    const cId = await myId(base, c);
    assert.equal((await postJson(base, '/api/me', { nudgeSuffix: '的小脑袋' }, b)).status, 200);
    assert.equal((await postJson(base, '/api/me', { nudgeSuffix: '超过十二个字的后缀超过十二个字' }, b)).status, 400);
    const nudge = await json(await postJson(base, '/api/nudge', { to: 'all', target: bId }, a));
    assert.deepEqual(nudge.nudge, { target: bId, targetName: 'B', suffix: '的小脑袋' });
    assert.equal((await postJson(base, '/api/nudge', { to: 'all', target: bId }, a)).status, 429);
    // C 在和 B 的私聊里拍 A：不行；拍自己可以
    const aId = await myId(base, a);
    assert.equal((await postJson(base, '/api/nudge', { to: bId, target: aId }, c)).status, 400);
    assert.equal((await postJson(base, '/api/nudge', { to: bId, target: cId }, c)).status, 200);
    await app.close();
});
test('备注：只有设置的人自己能看到', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const bId = await myId(base, b);
    const { remarks } = await json(await postJson(base, '/api/remarks', { userId: bId, remark: '财务-小B' }, a));
    assert.deepEqual(remarks, { [bId]: '财务-小B' });
    assert.deepEqual((await session(base, a)).remarks, { [bId]: '财务-小B' });
    assert.deepEqual((await session(base, b)).remarks, {});
    assert.ok(!JSON.stringify(await session(base, b)).includes('财务-小B'), '别人拿不到这个备注');
    assert.equal((await postJson(base, '/api/remarks', { userId: 'nobody', remark: 'x' }, a)).status, 400);
    assert.equal((await postJson(base, '/api/remarks', { userId: bId, remark: '这个备注超过了二十个字这个备注超过了二十个字' }, a)).status, 400);
    await postJson(base, '/api/remarks', { userId: bId, remark: '' }, a);
    assert.deepEqual((await session(base, a)).remarks, {});
    await app.close();
});
// ---------- 存储空间 ----------
test('存储空间：到 80% 提醒一次，满了不能发消息和文件，清理后恢复', async () => {
    const { app, base, dataDir } = await start({ maxStorageBytes: 10 * MB });
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const stream = await subscribe(base, b);
    const big = await json(await upload(base, a, 'all', 'big.bin', Buffer.alloc(8.5 * MB)));
    let storage = (await session(base, a)).storage;
    assert.equal(storage.level, 'warn');
    assert.equal(storage.alertId, 1);
    await wait(50);
    assert.ok(stream.read().includes('"type":"storage"'), '提醒推送给所有人');
    // 再传一点，还是 warn，提醒编号不变（只提醒一次）
    await upload(base, a, 'all', 'small.bin', Buffer.alloc(0.5 * MB));
    assert.equal((await session(base, a)).storage.alertId, 1);
    // 超过上限：文字、文件、转发、拍一拍都不行
    const bigger = await json(await upload(base, a, 'all', 'more.bin', Buffer.alloc(MB)));
    storage = (await session(base, a)).storage;
    assert.equal(storage.level, 'full');
    assert.equal(storage.alertId, 2);
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: 'x' }, b)).status, 507);
    assert.equal((await upload(base, b, 'all', 'x.bin', 'x')).status, 507);
    assert.equal((await postJson(base, '/api/forward', { ids: [big.id], to: ['all'], mode: 'single' }, b)).status, 507);
    // 别人不能清理我的文件
    assert.equal((await postJson(base, `/api/files/${big.file?.id}/delete`, {}, b)).status, 403);
    const list = await json(await get(base, '/api/storage', b));
    assert.deepEqual(list.files.map((file) => file.name), ['big.bin', 'more.bin', 'small.bin'], '从大到小');
    assert.ok(list.files.every((file) => !file.canDelete));
    // 上传者自己清理：文件删了，消息还在，标记为已清理
    assert.equal((await postJson(base, `/api/files/${big.file?.id}/delete`, {}, a)).status, 200);
    assert.ok(!existsSync(join(dataDir, 'files', big.file?.id ?? '')));
    const after = await session(base, b);
    assert.equal(after.messages.find((message) => message.id === big.id)?.file?.removed, true);
    assert.equal(after.storage.level, 'ok');
    assert.equal((await get(base, `/api/files/${big.file?.id}`, b)).status, 404);
    assert.equal((await postJson(base, '/api/messages', { to: 'all', text: '又能发了' }, b)).status, 200);
    assert.ok(bigger.file);
    stream.close();
    await app.close();
});
test('存储空间：在服务器电脑上用 localhost 打开的人能清理任何文件，但看不到别人私聊的文件名', async () => {
    const { app, base } = await start({ localAdmin: true });
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const admin = await login(base, 'Admin');
    const bId = await myId(base, b);
    const secret = await json(await upload(base, a, bId, '工资单.xlsx', 'salary'));
    const { files } = await json(await get(base, '/api/storage', admin));
    assert.equal(files.length, 1);
    assert.equal(files[0].name, '（别人私聊里的文件）');
    assert.equal(files[0].where, 'A ↔ B');
    assert.equal(files[0].canDelete, true);
    assert.equal((await session(base, admin)).admin, true);
    assert.equal((await postJson(base, `/api/files/${secret.file?.id}/delete`, {}, admin)).status, 200);
    await app.close();
});
// ---------- 历史消息和搜索 ----------
test('历史消息：每个会话先给最近 100 条，往上翻分页加载；只能看到自己的会话', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const c = await login(base, 'C');
    const bId = await myId(base, b);
    for (let i = 0; i < 230; i += 1)
        await send(base, a, { to: 'all', text: `群消息${i}` });
    await send(base, a, { to: bId, text: '私聊' });
    const first = await session(base, b);
    const group = first.messages.filter((message) => message.to === 'all');
    assert.equal(group.length, 100);
    assert.equal(group[0].text, '群消息130');
    assert.deepEqual(first.older, ['all']);
    assert.equal(first.messages.filter((message) => message.to === bId).length, 1);
    const page1 = await json(await get(base, `/api/messages?with=all&before=${group[0].id}`, b));
    assert.equal(page1.messages.length, 100);
    assert.equal(page1.messages[0].text, '群消息30');
    assert.equal(page1.hasMore, true);
    const page2 = await json(await get(base, `/api/messages?with=all&before=${page1.messages[0].id}`, b));
    assert.equal(page2.messages.length, 30);
    assert.equal(page2.hasMore, false);
    // C 翻 A 和 B 的私聊，什么也拿不到
    const aId = await myId(base, a);
    const sneaky = await json(await get(base, `/api/messages?with=${aId}&before=${group[0].id}`, c));
    assert.deepEqual(sneaky.messages, []);
    await app.close();
});
test('搜索：能搜到文字、文件名、转发里的内容；看不到的私聊搜不到', async () => {
    const { app, base } = await start();
    const a = await login(base, 'A');
    const b = await login(base, 'B');
    const c = await login(base, 'C');
    const bId = await myId(base, b);
    const plan = await send(base, a, { to: 'all', text: '下周的发布计划' });
    await send(base, a, { to: bId, text: '私聊里的计划' });
    await upload(base, a, 'all', '计划表.xlsx', 'x');
    await postJson(base, '/api/forward', { ids: [plan.id], to: [bId], mode: 'merge' }, a);
    const search = async (cookie, q) => (await json(await get(base, `/api/search?q=${encodeURIComponent(q)}`, cookie))).hits;
    assert.equal((await search(b, '计划')).length, 4);
    assert.equal((await search(c, '计划')).length, 2);
    assert.equal((await search(c, '私聊')).length, 0);
    assert.equal((await get(base, '/api/search?q=', c)).status, 400);
    await app.close();
});
// ---------- 旧版本数据 ----------
test('旧版本的数据：过期删掉的文件标记为已清理，还在的文件改成永久保存', async () => {
    const first = await start();
    const a = await login(first.base, 'A');
    const kept = await json(await upload(first.base, a, 'all', 'kept.txt', 'kept'));
    const gone = await json(await upload(first.base, a, 'all', 'gone.txt', 'gone'));
    await first.app.close();
    // 改成旧版本的格式：有 expiresAt，没有 owner；gone.txt 已经被旧版本过期删除
    const path = join(first.dataDir, 'messages.jsonl');
    const legacy = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        const message = JSON.parse(line);
        delete message.file.owner;
        message.file.expiresAt = Date.now() - 1000;
        return JSON.stringify(message);
    });
    writeFileSync(path, `${legacy.join('\n')}\n`);
    rmSync(join(first.dataDir, 'files', gone.file?.id ?? ''));
    const second = await start({ dataDir: first.dataDir });
    const { messages } = await session(second.base, a);
    const keptNow = messages.find((message) => message.id === kept.id)?.file;
    const goneNow = messages.find((message) => message.id === gone.id)?.file;
    assert.equal(goneNow?.removed, true);
    assert.equal(keptNow?.removed, undefined);
    assert.equal(keptNow?.owner, (await session(second.base, a)).me.id);
    assert.ok(!('expiresAt' in (keptNow ?? {})));
    assert.equal(await (await get(second.base, `/api/files/${kept.file?.id}`, a)).text(), 'kept');
    await second.app.close();
});
test('登录状态会顺延：打开页面时 Cookie 的有效期被刷新', async () => {
    const { app, base } = await start();
    const res = await postJson(base, '/api/login', { name: 'A', code: CODE });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    const sessionRes = await get(base, '/api/session', cookie);
    assert.match(sessionRes.headers.get('set-cookie') ?? '', /Max-Age=2592000/);
    await app.close();
});
