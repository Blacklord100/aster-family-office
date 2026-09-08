import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json } from '@/lib/server/http';
import { searchIntelligence } from '@/lib/server/intelligence-store';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const parsed = z
      .string()
      .trim()
      .min(2)
      .max(600)
      .safeParse(new URL(request.url).searchParams.get('q'));
    if (!parsed.success)
      throw new AccessError(400, 'INVALID_QUERY', 'Enter 2–600 characters.');
    return json(await searchIntelligence(ctx, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}
