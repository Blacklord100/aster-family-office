import { lifecycleRoute } from '@/lib/server/lifecycle';
import { serveEmailPreview } from '@/lib/server/email-preview-route';
export const runtime = 'nodejs';
async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await params;
  return serveEmailPreview(request, id, index);
}

export const GET = lifecycleRoute(handleGET);
