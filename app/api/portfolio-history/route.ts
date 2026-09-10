import {
  AccessError,
  errorResponse,
  requireWorkspace,
} from '@/lib/server/access';
import { PortfolioHistoryQuerySchema } from '@/lib/portfolio-history-contract';
import { readPortfolioHistory } from '@/lib/server/portfolio-history-store';
import { json } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const raw = new URL(request.url).searchParams.get('query');
    let query;
    try {
      if (raw && raw.length > 8192) throw new Error('Bounded query');
      query = PortfolioHistoryQuerySchema.parse(raw ? JSON.parse(raw) : {});
    } catch {
      throw new AccessError(
        400,
        'HISTORY_QUERY_INVALID',
        'Check the selected history scope, dates and currency.',
      );
    }
    return json(await readPortfolioHistory(ctx, query));
  } catch (error) {
    return errorResponse(error);
  }
}
