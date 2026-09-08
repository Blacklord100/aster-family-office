import { randomUUID } from 'node:crypto';
import { withTenant } from '@/lib/server/db';
import {
  requireWorkspace,
  assertSameOrigin,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { readBody, json } from '@/lib/server/http';
import { encrypt, sha256 } from '@/lib/server/crypto';
import { audit, rateLimit } from '@/lib/server/audit';
import {
  activeEngine,
  assertEngineEnabled,
  sealJobEngine,
} from '@/lib/server/engine-store';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await requireWorkspace(request, 'write');
    const bytes = await readBody(request, 11 * 1024 * 1024),
      body = await new Response(bytes as BodyInit, {
        headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
      }).formData();
    const file = body.get('file');
    if (
      !(file instanceof File) ||
      file.size < 1 ||
      file.size > 10 * 1024 * 1024
    )
      throw new AccessError(
        400,
        'INVALID_FILE',
        'Upload a PDF, EML or text file up to 10 MB.',
      );
    const name = Array.from(file.name)
        .map((c) => (c.charCodeAt(0) < 32 || c === '/' || c === '\\' ? '_' : c))
        .join('')
        .slice(0, 200),
      extension = name.split('.').at(-1)?.toLowerCase();
    if (!['pdf', 'eml', 'txt'].includes(extension ?? ''))
      throw new AccessError(
        415,
        'UNSUPPORTED_FILE',
        'Supported files are PDF, EML and TXT.',
      );
    const buffer = Buffer.from(await file.arrayBuffer());
    if (
      extension === 'pdf' &&
      !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
    )
      throw new AccessError(
        415,
        'INVALID_PDF',
        'The file does not have a valid PDF signature.',
      );
    if (extension !== 'pdf' && buffer.includes(0))
      throw new AccessError(
        415,
        'INVALID_TEXT',
        'This file is not supported text.',
      );
    const mime =
      extension === 'pdf'
        ? 'application/pdf'
        : extension === 'eml'
          ? 'message/rfc822'
          : 'text/plain';
    return await withTenant(ctx.organizationId, async (client) => {
      if (
        !(await rateLimit(
          client,
          'upload:' + ctx.organizationId + ':' + ctx.user.id,
          30,
          3600,
        ))
      )
        throw new AccessError(
          429,
          'RATE_LIMITED',
          'Upload limit reached. Try again later.',
        );
      const hash = sha256(buffer);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [ctx.organizationId + hash],
      );
      const existing = await client.query(
        'SELECT id FROM app_documents WHERE organization_id=$1 AND content_hash=$2',
        [ctx.organizationId, hash],
      );
      let documentId = existing.rows[0]?.id as string | undefined;
      if (!documentId) {
        documentId = randomUUID();
        await client.query(
          'INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            documentId,
            ctx.organizationId,
            ctx.user.id,
            name,
            mime,
            hash,
            buffer.length,
            encrypt(
              buffer,
              'document:' + ctx.organizationId + ':' + documentId,
            ),
          ],
        );
      }
      const { rows: org } = await client.query(
        'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1 FOR SHARE',
        [ctx.organizationId],
      );
      const engine = await activeEngine(client, ctx.organizationId);
      assertEngineEnabled(engine.config);
      const requested = body.get('mode'),
        mode =
          requested === 'workflow' || requested === 'agentic'
            ? requested
            : org[0].processing_mode;
      const active = await client.query(
        "SELECT id FROM app_jobs WHERE organization_id=$1 AND document_id=$2 AND mode=$3 AND engine_snapshot=$4::jsonb AND status IN ('queued','processing','awaiting_review')",
        [ctx.organizationId, documentId, mode, JSON.stringify(engine.snapshot)],
      );
      if (active.rows[0])
        return json(
          { jobId: active.rows[0].id, documentId, deduplicated: true },
          200,
        );
      const jobId = randomUUID();
      const pinned = sealJobEngine(
        engine.config,
        engine.snapshot,
        ctx.organizationId,
        jobId,
      );
      await client.query(
        'INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,engine_snapshot,engine_config) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          jobId,
          ctx.organizationId,
          documentId,
          ctx.user.id,
          mode,
          org[0].policy_revision,
          JSON.stringify(pinned.snapshot),
          pinned.payload,
        ],
      );
      await client.query(
        'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2)',
        [jobId, ctx.organizationId],
      );
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'document.queued',
        documentId,
        { mode, bytes: buffer.length },
      );
      return json({ jobId, documentId, deduplicated: !!existing.rows[0] }, 202);
    });
  } catch (e) {
    return errorResponse(e);
  }
}
