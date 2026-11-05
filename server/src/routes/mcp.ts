import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getUser } from '../auth.js';
import { APP_VERSION } from '../config.js';
import { sha256 } from '../crypto.js';
import { one } from '../db.js';
import { runTool, toolsFor, touchToken } from '../ai/tools.js';
import type { ToolContext } from '../ai/tools.js';

// MCP（Model Context Protocol）服务端：让 Hermes、Claude Desktop、Cursor 等外部 AI 把 Orbox 当作工具使用。
// 无状态模式：每个请求独立建一个 MCP 实例，用 Bearer 令牌识别用户。

function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'orbox', version: APP_VERSION });
  for (const t of toolsFor(ctx)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: unknown) => {
      try {
        return { content: [{ type: 'text' as const, text: await runTool(t.name, args, ctx) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
  }
  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req, reply) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const row = token ? await one<{ id: number; user_id: number; allow_send: number }>('SELECT id, user_id, allow_send FROM api_tokens WHERE token_hash = ?', [sha256(token)]) : undefined;
    const user = row && (await getUser(Number(row.user_id)));
    if (user && !user.perms.mcp) return reply.code(403).send({ jsonrpc: '2.0', error: { code: -32001, message: '管理员没有给你开放 MCP 外部连接' }, id: null });
    if (!row || !user) return reply.code(401).send({ jsonrpc: '2.0', error: { code: -32001, message: '令牌无效，请在 Orbox 设置 → AI 连接 里生成' }, id: null });
    void touchToken(row.id);

    const server = buildServer({ user, mode: 'mcp', allowSend: !!row.allow_send });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // 无状态模式不提供服务端推送流和会话删除
  const notAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
