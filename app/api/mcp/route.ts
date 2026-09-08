import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { requireMcpAccess } from '@/lib/server/mcp-access';
import { createAsterMcpServer } from '@/lib/server/mcp-server';
import { AccessError, errorResponse } from '@/lib/server/access';
import { readBody } from '@/lib/server/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  let server: ReturnType<typeof createAsterMcpServer> | undefined;
  try {
    const principal = await requireMcpAccess(request);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new AccessError(415, 'JSON_REQUIRED', 'Send a JSON request.');
    const bytes = await readBody(request, 65536);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AccessError(400, 'INVALID_REQUEST', 'Send valid JSON.');
    }
    if (Array.isArray(parsedBody))
      throw new AccessError(
        400,
        'INVALID_REQUEST',
        'Send one MCP request at a time.',
      );
    server = createAsterMcpServer(principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    // JSON mode completes the tool before returning the response. No SSE stream survives this request.
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch (error) {
    const response = errorResponse(error);
    if (response.status === 401)
      response.headers.set('WWW-Authenticate', 'Bearer realm="aster"');
    return response;
  } finally {
    await server?.close();
  }
}
export async function GET() {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
  });
}
export const DELETE = GET;
