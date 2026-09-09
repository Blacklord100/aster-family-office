import { serveEmailPreview } from '@/lib/server/email-preview-route';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return serveEmailPreview(request, id);
}
