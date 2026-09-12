import { lifecycleRoute } from '@/lib/server/lifecycle';
import { serveEmailPreview } from '@/lib/server/email-preview-route';
export const runtime = 'nodejs';
async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return serveEmailPreview(request, id);
}

export const GET = lifecycleRoute(handleGET);
