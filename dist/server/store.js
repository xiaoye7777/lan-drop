import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
// statfsSync 是 Node 18.15 才有的，用命名空间导入，旧版本 Node 上缺少它也不会启动失败
import * as fs from 'node:fs';
import { join } from 'node:path';
export const GROUP_RECIPIENT = 'all';
const TEMP_PREFIX = 'upload-';
/** 超过这个时间还没传完的临时文件，视为崩溃残留 */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
/** 用到容量上限的这个比例时提醒所有人 */
const STORAGE_WARN_RATIO = 0.8;
/** 服务器电脑的磁盘至少要留这么多空间，避免把整块盘写满影响电脑本身 */
const DISK_RESERVE_BYTES = 500 * 1024 * 1024;
function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
/** 先写临时文件再重命名，进程中途崩溃也不会留下写了一半的文件 */
function writeFileAtomic(path, content) {
    const temp = `${path}.tmp`;
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, path);
}
/** 一条消息里引用的所有文件：普通文件消息一个，合并转发里可能有多个 */
export function filesOf(message) {
    const files = [];
    if (message.file)
        files.push(message.file);
    for (const item of message.forward?.items ?? []) {
        if (item.file)
            files.push(item.file);
    }
    return files;
}
/** 搜索时用到的文字：正文、文件名、投票标题、转发里的内容等 */
function searchableText(message) {
    const parts = [
        message.text,
        message.file?.name,
        message.poll?.question,
        message.relay?.title,
        message.wheel?.title,
        message.forward?.title,
        ...(message.forward?.items ?? []).flatMap((item) => [item.text, item.file?.name, item.summary]),
    ];
    return parts.filter(Boolean).join('\n').toLowerCase();
}
/**
 * 服务器的全部持久化数据，都存在 dataDir 目录下：
 * - users.json     同事、个人资料、备注和登录会话。会话只存令牌的哈希值，文件泄露也拿不到可用的令牌
 * - messages.jsonl 消息记录，一行一条，永久保存。新消息直接追加；投票等状态变化或撤回时整个重写
 * - files/         上传的文件，文件名是随机 id，原文件名存在消息里
 * - avatars/       头像，文件名是用户 id
 * - stickers.json  全组共享的自定义表情列表，图片在 stickers/ 目录
 * - state.json     存储空间提醒的状态
 *
 * 使用人数很少，所以直接用同步读写，换取代码简单。
 */
export class Store {
    config;
    filesDir;
    avatarsDir;
    stickersDir;
    usersPath;
    messagesPath;
    stickersPath;
    statePath;
    users = new Map();
    sessions = new Map();
    /** 按时间顺序排列的全部消息 */
    messages = [];
    messageIndex = new Map();
    /** 消息的先后顺序编号。同一毫秒内发出的消息时间相同，排序要靠它 */
    messageOrder = new WeakMap();
    nextOrder = 0;
    /**
     * 文件 id -> 引用它的消息。同一个文件被转发后会被多条消息引用，
     * 最后一条引用它的消息被撤回时，文件才从磁盘删除。已清理的文件不在这里
     */
    fileRefs = new Map();
    stickers = [];
    /** 磁盘上还存在的文件的总大小 */
    filesBytes = 0;
    /** messages.jsonl 的大小 */
    messagesBytes = 0;
    /** 正在上传的文件预占的容量 */
    reservedBytes = 0;
    state = { storageLevel: 'ok', storageAlert: 0 };
    /** 存储空间状态变化时通知外面（推送给所有人），由 app.ts 设置 */
    onStorageChange = () => undefined;
    constructor(config) {
        this.config = config;
        this.filesDir = join(config.dataDir, 'files');
        this.avatarsDir = join(config.dataDir, 'avatars');
        this.stickersDir = join(config.dataDir, 'stickers');
        this.usersPath = join(config.dataDir, 'users.json');
        this.messagesPath = join(config.dataDir, 'messages.jsonl');
        this.stickersPath = join(config.dataDir, 'stickers.json');
        this.statePath = join(config.dataDir, 'state.json');
        for (const dir of [this.filesDir, this.avatarsDir, this.stickersDir])
            mkdirSync(dir, { recursive: true });
        this.load();
    }
    load() {
        if (existsSync(this.usersPath)) {
            const saved = JSON.parse(readFileSync(this.usersPath, 'utf8'));
            for (const user of saved.users)
                this.users.set(user.id, user);
            for (const [hash, session] of Object.entries(saved.sessions))
                this.sessions.set(hash, session);
        }
        if (existsSync(this.stickersPath)) {
            this.stickers = JSON.parse(readFileSync(this.stickersPath, 'utf8'));
        }
        if (existsSync(this.statePath)) {
            try {
                this.state = { ...this.state, ...JSON.parse(readFileSync(this.statePath, 'utf8')) };
            }
            catch {
                // 状态文件损坏只影响提醒，从头开始即可
            }
        }
        let changed = false;
        if (existsSync(this.messagesPath)) {
            const content = readFileSync(this.messagesPath, 'utf8');
            this.messagesBytes = Buffer.byteLength(content);
            for (const line of content.split('\n')) {
                if (!line)
                    continue;
                let message;
                try {
                    message = JSON.parse(line);
                }
                catch {
                    // 只可能是崩溃时写了一半的最后一行，跳过即可
                    continue;
                }
                if (this.upgradeMessage(message))
                    changed = true;
                this.indexMessage(message);
            }
        }
        if (changed)
            this.saveMessages();
        this.updateStorageLevel();
    }
    /**
     * 兼容旧版本的数据，并核对文件是否还在磁盘上。返回是否改动了消息。
     * 旧版本的文件有保留期限（expiresAt），现在改成永久保存；过期时已被删掉的文件标记为已清理
     */
    upgradeMessage(message) {
        let changed = false;
        for (const file of filesOf(message)) {
            const legacy = file;
            if (legacy.expiresAt !== undefined) {
                delete legacy.expiresAt;
                changed = true;
            }
            if (!file.owner) {
                file.owner = message.from;
                changed = true;
            }
            if (!file.removed && !existsSync(this.filePath(file.id))) {
                file.removed = true;
                changed = true;
            }
        }
        return changed;
    }
    indexMessage(message) {
        this.messages.push(message);
        this.messageIndex.set(message.id, message);
        this.messageOrder.set(message, this.nextOrder++);
        for (const file of filesOf(message)) {
            if (file.removed)
                continue;
            let refs = this.fileRefs.get(file.id);
            if (!refs) {
                refs = new Set();
                this.fileRefs.set(file.id, refs);
                this.filesBytes += file.size;
            }
            refs.add(message);
        }
    }
    /** 一条消息被删除时，去掉它对文件的引用；文件没有任何消息引用了，就从磁盘删除 */
    dropFileRefs(message) {
        for (const file of filesOf(message)) {
            const refs = this.fileRefs.get(file.id);
            if (!refs)
                continue;
            refs.delete(message);
            if (refs.size > 0)
                continue;
            this.fileRefs.delete(file.id);
            this.filesBytes -= file.size;
            this.deleteFromDisk(file.id);
        }
    }
    deleteFromDisk(fileId) {
        try {
            rmSync(this.filePath(fileId), { force: true });
        }
        catch {
            // Windows 上文件正被下载时可能删不掉；它已经不属于任何消息，定期清理时会再删
        }
    }
    saveUsers() {
        writeFileAtomic(this.usersPath, JSON.stringify({ users: [...this.users.values()], sessions: Object.fromEntries(this.sessions) }));
    }
    saveMessages() {
        const content = this.messages.map((message) => `${JSON.stringify(message)}\n`).join('');
        writeFileAtomic(this.messagesPath, content);
        this.messagesBytes = Buffer.byteLength(content);
    }
    saveStickers() {
        writeFileAtomic(this.stickersPath, JSON.stringify(this.stickers));
    }
    saveState() {
        writeFileAtomic(this.statePath, JSON.stringify(this.state));
    }
    // ---------- 同事和会话 ----------
    listUsers() {
        return [...this.users.values()];
    }
    getUser(id) {
        return this.users.get(id);
    }
    /** 同一台电脑用同一个昵称重新登录时，沿用原来的身份，历史消息不会丢 */
    findUserByNameAndIp(name, ip) {
        return this.listUsers().find((user) => user.name === name && user.ip === ip);
    }
    createUser(name, ip) {
        const user = { id: randomUUID(), name, ip, lastSeenAt: Date.now() };
        this.users.set(user.id, user);
        this.saveUsers();
        return user;
    }
    /** 修改个人资料。只改传入的字段，调用前已经校验过取值 */
    updateProfile(user, patch) {
        Object.assign(user, patch);
        this.saveUsers();
    }
    /** 设置或清除给某位同事的备注 */
    setRemark(user, targetId, remark) {
        const remarks = { ...user.remarks };
        if (remark)
            remarks[targetId] = remark;
        else
            delete remarks[targetId];
        user.remarks = remarks;
        this.saveUsers();
    }
    /** 新建会话并返回令牌原文。令牌原文只存在于浏览器 Cookie 中 */
    createSession(userId) {
        const token = randomBytes(32).toString('base64url');
        this.sessions.set(hashToken(token), { userId, expiresAt: Date.now() + this.config.sessionTtlMs });
        this.saveUsers();
        return token;
    }
    deleteSession(token) {
        if (this.sessions.delete(hashToken(token)))
            this.saveUsers();
    }
    /**
     * 根据令牌找到当前用户，同时记录最近活跃时间。
     * 登录状态每次使用都顺延，经常用的同事不会被要求重新登录（重新登录可能因为 IP 变了而变成新身份）
     */
    authenticate(token, ip) {
        const session = this.sessions.get(hashToken(token));
        if (!session || session.expiresAt < Date.now())
            return undefined;
        const user = this.users.get(session.userId);
        if (!user)
            return undefined;
        user.lastSeenAt = Date.now();
        // 内存里先顺延，定期清理时统一落盘，免得每个请求都写文件
        session.expiresAt = Date.now() + this.config.sessionTtlMs;
        if (user.ip !== ip) {
            user.ip = ip;
            this.saveUsers();
        }
        return user;
    }
    // ---------- 头像 ----------
    avatarPath(userId) {
        return join(this.avatarsDir, userId);
    }
    setAvatar(user, type, data) {
        writeFileAtomic(this.avatarPath(user.id), data);
        user.avatar = { type, version: (user.avatar?.version ?? 0) + 1 };
        this.saveUsers();
    }
    removeAvatar(user) {
        rmSync(this.avatarPath(user.id), { force: true });
        delete user.avatar;
        this.saveUsers();
    }
    // ---------- 消息 ----------
    /** 判断某个用户能否看到这条消息：全组消息所有人可见，私聊只有双方可见 */
    canView(message, userId) {
        return message.to === GROUP_RECIPIENT || message.from === userId || message.to === userId;
    }
    /** 从某个用户的角度看，消息属于哪个会话：全组是 all，私聊是对方的 id */
    conversationFor(message, userId) {
        if (message.to === GROUP_RECIPIENT)
            return GROUP_RECIPIENT;
        return message.from === userId ? message.to : message.from;
    }
    /** 每个会话最近的 perConversation 条消息（按时间正序），以及哪些会话还有更早的消息 */
    recentFor(userId, perConversation) {
        const counts = new Map();
        const older = new Set();
        const result = [];
        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
            const message = this.messages[i];
            if (!this.canView(message, userId))
                continue;
            const key = this.conversationFor(message, userId);
            const count = counts.get(key) ?? 0;
            if (count >= perConversation) {
                older.add(key);
                continue;
            }
            counts.set(key, count + 1);
            result.push(message);
        }
        return { messages: result.reverse(), older: [...older] };
    }
    /**
     * 某个会话里比 beforeId 更早的一页消息（按时间正序）。
     * beforeId 找不到（比如已被撤回）时返回 undefined
     */
    pageBefore(userId, conversation, beforeId, limit) {
        const before = this.messageIndex.get(beforeId);
        if (!before)
            return undefined;
        const result = [];
        let hasMore = false;
        for (let i = this.messages.indexOf(before) - 1; i >= 0; i -= 1) {
            const message = this.messages[i];
            if (!this.canView(message, userId) || this.conversationFor(message, userId) !== conversation)
                continue;
            if (result.length === limit) {
                hasMore = true;
                break;
            }
            result.push(message);
        }
        return { messages: result.reverse(), hasMore };
    }
    /** 在自己能看到的消息里搜索，从新到旧 */
    search(userId, query, limit) {
        const needle = query.toLowerCase();
        const hits = [];
        for (let i = this.messages.length - 1; i >= 0 && hits.length < limit; i -= 1) {
            const message = this.messages[i];
            if (!this.canView(message, userId) || !searchableText(message).includes(needle))
                continue;
            hits.push({ conversation: this.conversationFor(message, userId), message });
        }
        return hits;
    }
    /** 按发送的先后排序 */
    chronological(messages) {
        const order = (message) => this.messageOrder.get(message) ?? 0;
        return [...messages].sort((a, b) => order(a) - order(b));
    }
    findMessage(id) {
        return this.messageIndex.get(id);
    }
    isValidRecipient(to) {
        return to === GROUP_RECIPIENT || this.users.has(to);
    }
    addMessage(from, to, content) {
        const message = {
            id: randomUUID(),
            from: from.id,
            fromName: from.name,
            to,
            at: Date.now(),
            ...content,
        };
        this.indexMessage(message);
        const line = `${JSON.stringify(message)}\n`;
        appendFileSync(this.messagesPath, line, { mode: 0o600 });
        this.messagesBytes += Buffer.byteLength(line);
        this.storageChanged(filesOf(message).length > 0);
        return message;
    }
    /**
     * 永久删除一条消息（撤回）：从内存和 messages.jsonl 里去掉，带文件的连文件一起删
     * （文件被转发过的话，转发出去的那份还在）。引用了它的回复，引用内容也一起清空。
     * 返回因此被修改的其他消息，需要推送给相关的人。
     */
    deleteMessage(message) {
        this.messages = this.messages.filter((item) => item !== message);
        this.messageIndex.delete(message.id);
        this.dropFileRefs(message);
        const changed = [];
        for (const item of this.messages) {
            if (item.reply?.id !== message.id || item.reply.recalled)
                continue;
            item.reply = { id: message.id, from: message.from, fromName: message.fromName, summary: '', recalled: true };
            changed.push(item);
        }
        this.saveMessages();
        this.storageChanged(filesOf(message).length > 0);
        return changed;
    }
    /** 消息内容（投票结果、棋局等）已经在内存里改好了，这里负责落盘 */
    saveMessageChange() {
        this.saveMessages();
    }
    // ---------- 文件 ----------
    filePath(fileId) {
        return join(this.filesDir, fileId);
    }
    newTempFilePath() {
        return join(this.filesDir, `${TEMP_PREFIX}${randomUUID()}`);
    }
    /** 用户能访问的文件：至少能看到一条引用它的消息。看不到或已清理时返回 undefined */
    accessibleFile(fileId, userId) {
        for (const message of this.fileRefs.get(fileId) ?? []) {
            if (!this.canView(message, userId))
                continue;
            return filesOf(message).find((file) => file.id === fileId);
        }
        return undefined;
    }
    /** 文件的元数据，以及最早上传它的那条消息（判断文件在哪个会话） */
    fileOrigin(fileId, refs) {
        let origin;
        for (const message of refs) {
            if (!origin || message.at < origin.at)
                origin = message;
        }
        const meta = origin && filesOf(origin).find((file) => file.id === fileId);
        return origin && meta ? { meta, origin } : undefined;
    }
    /** 存储空间管理里的文件列表，按大小从大到小。管理员能看到所有文件，但别人私聊的文件名会被隐藏 */
    listFiles(userId, admin) {
        const nameOf = (id, fallback) => this.users.get(id)?.name ?? fallback;
        const list = [];
        for (const [fileId, refs] of this.fileRefs) {
            const visible = [...refs].some((message) => this.canView(message, userId));
            if (!visible && !admin)
                continue;
            const found = this.fileOrigin(fileId, refs);
            if (!found)
                continue;
            const { meta, origin } = found;
            list.push({
                id: fileId,
                name: visible ? meta.name : '（别人私聊里的文件）',
                size: meta.size,
                owner: meta.owner,
                ownerName: nameOf(meta.owner, origin.fromName),
                at: origin.at,
                where: origin.to === GROUP_RECIPIENT ? '全组' : `${nameOf(origin.from, origin.fromName)} ↔ ${nameOf(origin.to, '已离开的同事')}`,
                ...(visible && meta.image ? { image: meta.image } : {}),
                canDelete: admin || meta.owner === userId,
            });
        }
        return list.sort((a, b) => b.size - a.size);
    }
    /** 文件的上传者，文件不存在或已清理时返回 undefined */
    fileOwner(fileId) {
        const refs = this.fileRefs.get(fileId);
        return refs ? this.fileOrigin(fileId, refs)?.meta.owner : undefined;
    }
    /**
     * 清理一个文件（腾空间）：从磁盘删除，引用它的消息保留，标记为“已清理”。
     * 返回被修改的消息，需要推送给相关的人
     */
    removeFile(fileId) {
        const refs = this.fileRefs.get(fileId);
        if (!refs)
            return [];
        let size = 0;
        for (const message of refs) {
            for (const file of filesOf(message)) {
                if (file.id !== fileId)
                    continue;
                file.removed = true;
                size = file.size;
            }
        }
        this.fileRefs.delete(fileId);
        this.filesBytes -= size;
        this.deleteFromDisk(fileId);
        this.saveMessages();
        this.storageChanged(true);
        return [...refs];
    }
    // ---------- 存储空间 ----------
    storageUsed() {
        return this.filesBytes + this.messagesBytes + this.stickers.reduce((sum, sticker) => sum + sticker.size, 0);
    }
    storageInfo() {
        return {
            used: this.storageUsed(),
            limit: this.config.maxStorageBytes,
            level: this.state.storageLevel,
            alertId: this.state.storageAlert,
        };
    }
    isStorageFull() {
        return this.storageUsed() >= this.config.maxStorageBytes;
    }
    /** 重新判断存储级别。升到更高一级时提醒编号加 1。返回级别是否变了 */
    updateStorageLevel() {
        const used = this.storageUsed();
        const limit = this.config.maxStorageBytes;
        const level = used >= limit ? 'full' : used >= limit * STORAGE_WARN_RATIO ? 'warn' : 'ok';
        const previous = this.state.storageLevel;
        if (level === previous)
            return false;
        const rank = { ok: 0, warn: 1, full: 2 };
        this.state = {
            storageLevel: level,
            storageAlert: this.state.storageAlert + (rank[level] > rank[previous] ? 1 : 0),
        };
        this.saveState();
        return true;
    }
    /**
     * 占用变化后调用。文件增减或级别变化时通知所有人，侧边栏的用量随之更新；
     * 只是多了一条文字消息时不通知，免得每条消息都多推送一次
     */
    storageChanged(filesChanged) {
        const levelChanged = this.updateStorageLevel();
        if (levelChanged || filesChanged)
            this.onStorageChange(this.storageInfo());
    }
    /**
     * 上传前预占容量。返回 null 表示可以上传，否则返回拒绝的原因。
     * 只要还没满就允许上传，所以总量可能略微超过上限（最多一个文件的大小）
     */
    reserveStorage(bytes) {
        if (this.storageUsed() + this.reservedBytes >= this.config.maxStorageBytes) {
            return '存储空间已满，请先清理一些文件再发送';
        }
        try {
            const disk = fs.statfsSync?.(this.filesDir);
            if (disk && disk.bavail * disk.bsize < bytes + this.reservedBytes + DISK_RESERVE_BYTES) {
                return '服务器电脑的磁盘空间不足，请联系管理员';
            }
        }
        catch {
            // 读不到磁盘信息时不拦截
        }
        this.reservedBytes += bytes;
        return null;
    }
    releaseStorage(bytes) {
        this.reservedBytes -= bytes;
    }
    // ---------- 自定义表情 ----------
    listStickers() {
        return this.stickers;
    }
    findSticker(id) {
        return this.stickers.find((sticker) => sticker.id === id);
    }
    stickerPath(id) {
        return join(this.stickersDir, id);
    }
    addSticker(owner, name, type, data) {
        const sticker = { id: randomUUID(), name, owner: owner.id, type, size: data.length };
        writeFileAtomic(this.stickerPath(sticker.id), data);
        this.stickers = [...this.stickers, sticker];
        this.saveStickers();
        this.storageChanged(true);
        return sticker;
    }
    removeSticker(id) {
        this.stickers = this.stickers.filter((sticker) => sticker.id !== id);
        this.saveStickers();
        rmSync(this.stickerPath(id), { force: true });
        this.storageChanged(true);
    }
    // ---------- 定期清理 ----------
    /** 清理过期的登录会话，以及磁盘上的残留文件。消息和文件永久保存，不会被清理 */
    sweep(now = Date.now()) {
        for (const [hash, session] of this.sessions) {
            if (session.expiresAt <= now)
                this.sessions.delete(hash);
        }
        // 每次都保存：最近活跃时间和会话顺延平时只更新内存，要定期落盘
        this.saveUsers();
        // 磁盘上没有被引用的文件：崩溃残留的临时文件，或撤回时没删掉的文件
        for (const name of readdirSync(this.filesDir)) {
            const path = join(this.filesDir, name);
            if (name.startsWith(TEMP_PREFIX)) {
                if (statSync(path).mtimeMs + TEMP_FILE_MAX_AGE_MS < now)
                    rmSync(path, { force: true });
            }
            else if (!this.fileRefs.has(name)) {
                rmSync(path, { force: true });
            }
        }
        for (const name of readdirSync(this.avatarsDir)) {
            if (!this.users.get(name)?.avatar)
                rmSync(join(this.avatarsDir, name), { force: true });
        }
        for (const name of readdirSync(this.stickersDir)) {
            if (!this.findSticker(name))
                rmSync(join(this.stickersDir, name), { force: true });
        }
    }
}
