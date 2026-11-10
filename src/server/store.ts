import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, CustomSticker, GroupRecipient, ImageType, Recipient } from '../shared/types.js';
import type { Config } from './config.js';

export const GROUP_RECIPIENT: GroupRecipient = 'all';

const TEMP_PREFIX = 'upload-';
/** 超过这个时间还没传完的临时文件，视为崩溃残留 */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

export interface StoredUser {
  id: string;
  name: string;
  ip: string;
  lastSeenAt: number;
  avatar?: { type: ImageType; version: number };
  bio?: string;
  nameplate?: string;
  bubble?: string;
}

interface StoredSession {
  userId: string;
  expiresAt: number;
}

/** 消息里除了基本信息之外的内容部分 */
export type MessageContent = Pick<
  ChatMessage,
  'text' | 'effect' | 'file' | 'sticker' | 'poll' | 'relay' | 'wheel' | 'gomoku'
>;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 先写临时文件再重命名，进程中途崩溃也不会留下写了一半的文件 */
function writeFileAtomic(path: string, content: string | Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * 服务器的全部持久化数据，都存在 dataDir 目录下：
 * - users.json     同事、个人资料和登录会话。会话只存令牌的哈希值，文件泄露也拿不到可用的令牌
 * - messages.jsonl 消息记录，一行一条。新消息直接追加；投票等消息状态变化时整个重写
 * - files/         上传的文件，文件名是随机 id，原文件名存在消息里
 * - avatars/       头像，文件名是用户 id
 * - stickers.json  全组共享的自定义表情列表，图片在 stickers/ 目录
 *
 * 使用人数很少，所以直接用同步读写，换取代码简单。
 */
export class Store {
  readonly filesDir: string;
  private readonly avatarsDir: string;
  private readonly stickersDir: string;
  private readonly usersPath: string;
  private readonly messagesPath: string;
  private readonly stickersPath: string;

  private readonly users = new Map<string, StoredUser>();
  private readonly sessions = new Map<string, StoredSession>();
  private messages: ChatMessage[] = [];
  private readonly messageIndex = new Map<string, ChatMessage>();
  /** 文件 id -> 所属消息，用于下载时的查找和权限判断 */
  private readonly fileIndex = new Map<string, ChatMessage>();
  private stickers: CustomSticker[] = [];
  /** 正在上传的文件预占的容量，防止并发上传时超过总容量上限 */
  private reservedBytes = 0;

  constructor(private readonly config: Config) {
    this.filesDir = join(config.dataDir, 'files');
    this.avatarsDir = join(config.dataDir, 'avatars');
    this.stickersDir = join(config.dataDir, 'stickers');
    this.usersPath = join(config.dataDir, 'users.json');
    this.messagesPath = join(config.dataDir, 'messages.jsonl');
    this.stickersPath = join(config.dataDir, 'stickers.json');
    for (const dir of [this.filesDir, this.avatarsDir, this.stickersDir]) mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (existsSync(this.usersPath)) {
      const saved = JSON.parse(readFileSync(this.usersPath, 'utf8')) as {
        users: StoredUser[];
        sessions: Record<string, StoredSession>;
      };
      for (const user of saved.users) this.users.set(user.id, user);
      for (const [hash, session] of Object.entries(saved.sessions)) this.sessions.set(hash, session);
    }
    if (existsSync(this.messagesPath)) {
      for (const line of readFileSync(this.messagesPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          this.indexMessage(JSON.parse(line) as ChatMessage);
        } catch {
          // 只可能是崩溃时写了一半的最后一行，跳过即可
        }
      }
    }
    if (existsSync(this.stickersPath)) {
      this.stickers = JSON.parse(readFileSync(this.stickersPath, 'utf8')) as CustomSticker[];
    }
  }

  private indexMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.messageIndex.set(message.id, message);
    if (message.file) this.fileIndex.set(message.file.id, message);
  }

  private saveUsers(): void {
    writeFileAtomic(
      this.usersPath,
      JSON.stringify({ users: [...this.users.values()], sessions: Object.fromEntries(this.sessions) }),
    );
  }

  private saveMessages(): void {
    writeFileAtomic(this.messagesPath, this.messages.map((message) => `${JSON.stringify(message)}\n`).join(''));
  }

  private saveStickers(): void {
    writeFileAtomic(this.stickersPath, JSON.stringify(this.stickers));
  }

  // ---------- 同事和会话 ----------

  listUsers(): StoredUser[] {
    return [...this.users.values()];
  }

  getUser(id: string): StoredUser | undefined {
    return this.users.get(id);
  }

  /** 同一台电脑用同一个昵称重新登录时，沿用原来的身份，历史消息不会丢 */
  findUserByNameAndIp(name: string, ip: string): StoredUser | undefined {
    return this.listUsers().find((user) => user.name === name && user.ip === ip);
  }

  createUser(name: string, ip: string): StoredUser {
    const user: StoredUser = { id: randomUUID(), name, ip, lastSeenAt: Date.now() };
    this.users.set(user.id, user);
    this.saveUsers();
    return user;
  }

  /** 修改个人资料。只改传入的字段，调用前已经校验过取值 */
  updateProfile(user: StoredUser, patch: Partial<Pick<StoredUser, 'name' | 'bio' | 'nameplate' | 'bubble'>>): void {
    Object.assign(user, patch);
    this.saveUsers();
  }

  /** 新建会话并返回令牌原文。令牌原文只存在于浏览器 Cookie 中 */
  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(hashToken(token), { userId, expiresAt: Date.now() + this.config.sessionTtlMs });
    this.saveUsers();
    return token;
  }

  deleteSession(token: string): void {
    if (this.sessions.delete(hashToken(token))) this.saveUsers();
  }

  /** 根据令牌找到当前用户，同时记录最近活跃时间 */
  authenticate(token: string, ip: string): StoredUser | undefined {
    const session = this.sessions.get(hashToken(token));
    if (!session || session.expiresAt < Date.now()) return undefined;
    const user = this.users.get(session.userId);
    if (!user) return undefined;
    user.lastSeenAt = Date.now();
    if (user.ip !== ip) {
      user.ip = ip;
      this.saveUsers();
    }
    return user;
  }

  // ---------- 头像 ----------

  avatarPath(userId: string): string {
    return join(this.avatarsDir, userId);
  }

  setAvatar(user: StoredUser, type: ImageType, data: Buffer): void {
    writeFileAtomic(this.avatarPath(user.id), data);
    user.avatar = { type, version: (user.avatar?.version ?? 0) + 1 };
    this.saveUsers();
  }

  removeAvatar(user: StoredUser): void {
    rmSync(this.avatarPath(user.id), { force: true });
    delete user.avatar;
    this.saveUsers();
  }

  // ---------- 消息 ----------

  /** 判断某个用户能否看到这条消息：全组消息所有人可见，私聊只有双方可见 */
  canView(message: ChatMessage, userId: string): boolean {
    return message.to === GROUP_RECIPIENT || message.from === userId || message.to === userId;
  }

  messagesFor(userId: string): ChatMessage[] {
    return this.messages.filter((message) => this.canView(message, userId));
  }

  findMessage(id: string): ChatMessage | undefined {
    return this.messageIndex.get(id);
  }

  isValidRecipient(to: Recipient): boolean {
    return to === GROUP_RECIPIENT || this.users.has(to);
  }

  addMessage(from: StoredUser, to: Recipient, content: MessageContent): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      from: from.id,
      fromName: from.name,
      to,
      at: Date.now(),
      ...content,
    };
    this.indexMessage(message);
    appendFileSync(this.messagesPath, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    return message;
  }

  /**
   * 永久删除一条消息（撤回）：从内存和 messages.jsonl 里去掉，带文件的连文件一起删。
   * 不留任何记录，重启后也找不回来。
   */
  deleteMessage(message: ChatMessage): void {
    this.messages = this.messages.filter((item) => item !== message);
    this.messageIndex.delete(message.id);
    if (message.file) {
      this.fileIndex.delete(message.file.id);
      try {
        rmSync(this.filePath(message.file.id), { force: true });
      } catch {
        // 文件正被别人下载时（Windows 上）可能删不掉；它已经不属于任何消息，定期清理时会删掉
      }
    }
    this.saveMessages();
  }

  /** 消息内容（投票结果、棋局等）已经在内存里改好了，这里负责落盘 */
  saveMessageChange(): void {
    this.saveMessages();
  }

  // ---------- 文件 ----------

  findFile(fileId: string): ChatMessage | undefined {
    return this.fileIndex.get(fileId);
  }

  filePath(fileId: string): string {
    return join(this.filesDir, fileId);
  }

  newTempFilePath(): string {
    return join(this.filesDir, `${TEMP_PREFIX}${randomUUID()}`);
  }

  /** 预占容量。放不下时返回 false */
  reserveStorage(bytes: number): boolean {
    const now = Date.now();
    let used = this.reservedBytes;
    for (const { file } of this.fileIndex.values()) {
      if (file && file.expiresAt > now) used += file.size;
    }
    if (used + bytes > this.config.maxStorageBytes) return false;
    this.reservedBytes += bytes;
    return true;
  }

  releaseStorage(bytes: number): void {
    this.reservedBytes -= bytes;
  }

  // ---------- 自定义表情 ----------

  listStickers(): CustomSticker[] {
    return this.stickers;
  }

  findSticker(id: string): CustomSticker | undefined {
    return this.stickers.find((sticker) => sticker.id === id);
  }

  stickerPath(id: string): string {
    return join(this.stickersDir, id);
  }

  addSticker(owner: StoredUser, name: string, type: ImageType, data: Buffer): CustomSticker {
    const sticker: CustomSticker = { id: randomUUID(), name, owner: owner.id, type, size: data.length };
    writeFileAtomic(this.stickerPath(sticker.id), data);
    this.stickers = [...this.stickers, sticker];
    this.saveStickers();
    return sticker;
  }

  removeSticker(id: string): void {
    this.stickers = this.stickers.filter((sticker) => sticker.id !== id);
    this.saveStickers();
    rmSync(this.stickerPath(id), { force: true });
  }

  // ---------- 定期清理 ----------

  /** 清理过期的文件、消息、会话，以及长期不活跃的同事和残留文件 */
  sweep(now = Date.now()): void {
    // 文件：到期就从磁盘删除，消息保留，前端显示“已过期”
    for (const [fileId, message] of this.fileIndex) {
      if (message.file && message.file.expiresAt <= now) {
        rmSync(this.filePath(fileId), { force: true });
        this.fileIndex.delete(fileId);
      }
    }

    // 消息：只有确实删掉了内容才重写文件
    const kept = this.messages.filter((message) => message.at + this.config.messageTtlMs > now);
    if (kept.length !== this.messages.length) {
      for (const message of this.messages) {
        if (!kept.includes(message)) this.messageIndex.delete(message.id);
      }
      this.messages = kept;
      this.saveMessages();
    }

    // 会话和不活跃的同事
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash);
    }
    for (const [id, user] of this.users) {
      if (user.lastSeenAt + this.config.sessionTtlMs <= now) this.users.delete(id);
    }
    // 每次都保存：最近活跃时间平时只更新内存，要定期落盘，否则重启后活跃的同事可能被误清理
    this.saveUsers();

    // 磁盘上没有被引用的文件：崩溃残留的临时文件，或写入记录前进程退出留下的文件
    for (const name of readdirSync(this.filesDir)) {
      const path = join(this.filesDir, name);
      if (name.startsWith(TEMP_PREFIX)) {
        if (statSync(path).mtimeMs + TEMP_FILE_MAX_AGE_MS < now) rmSync(path, { force: true });
      } else if (!this.fileIndex.has(name)) {
        rmSync(path, { force: true });
      }
    }
    for (const name of readdirSync(this.avatarsDir)) {
      if (!this.users.get(name)?.avatar) rmSync(join(this.avatarsDir, name), { force: true });
    }
    for (const name of readdirSync(this.stickersDir)) {
      if (!this.findSticker(name)) rmSync(join(this.stickersDir, name), { force: true });
    }
  }
}
