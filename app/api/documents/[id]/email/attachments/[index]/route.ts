import { serveEmailPreview } from '@/lib/server/email-preview-route';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await params;
  return serveEmailPreview(request, id, index);
}
