import type { ServerResponse } from 'node:http';

// 进程内事件总线：把服务端变化通过 SSE 推给该用户所有打开的页面
export type AppEvent =
  | { type: 'mail'; accountId: number; folderId?: number }
  | { type: 'new-mail'; id: number; from: string; subject: string; code: string | null }
  | { type: 'outbox' }
  | { type: 'accounts' }
  | { type: 'tasks' }
  | { type: 'notes' }
  | { type: 'reminder'; id: number; title: string };

const clients = new Map<number, Set<ServerResponse>>();

export function subscribe(userId: number, res: ServerResponse): () => void {
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  set.add(res);
  return () => {
    set.delete(res);
    if (!set.size) clients.delete(userId);
  };
}

export function emit(userId: number, event: AppEvent): void {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(payload);
}

setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();
