import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.js';

const HEARTBEAT_MS = 25_000;

/**
 * 管理所有浏览器的 SSE 长连接。
 * 一个同事可能开多个标签页，所以每个用户对应一组连接；
 * 只要还有一条连接，这位同事就算在线。
 */
export class EventHub {
  private readonly connections = new Map<string, Set<ServerResponse>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    // 定期发一行注释，防止空闲连接被网络设备断开，也能及早发现已失效的连接
    this.heartbeat = setInterval(() => this.writeAll(': ping\n\n'), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** 接入一条新连接。返回值表示这位同事是否刚从离线变成在线 */
  add(userId: string, res: ServerResponse): boolean {
    let group = this.connections.get(userId);
    const cameOnline = group === undefined;
    if (!group) {
      group = new Set();
      this.connections.set(userId, group);
    }
    group.add(res);
    return cameOnline;
  }

  /** 移除一条连接。返回值表示这位同事是否刚变成离线 */
  remove(userId: string, res: ServerResponse): boolean {
    const group = this.connections.get(userId);
    if (!group) return false;
    group.delete(res);
    if (group.size > 0) return false;
    this.connections.delete(userId);
    return true;
  }

  isOnline(userId: string): boolean {
    return this.connections.has(userId);
  }

  broadcast(event: ServerEvent): void {
    this.writeAll(`data: ${JSON.stringify(event)}\n\n`);
  }

  sendTo(userIds: Iterable<string>, event: ServerEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const userId of new Set(userIds)) {
      for (const res of this.connections.get(userId) ?? []) res.write(frame);
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const group of this.connections.values()) {
      for (const res of group) res.end();
    }
    this.connections.clear();
  }

  private writeAll(frame: string): void {
    for (const group of this.connections.values()) {
      for (const res of group) res.write(frame);
    }
  }
}
