"""Knowledge endpoints share the existing authenticated, disposable-process sandbox."""
import base64
from fastapi import APIRouter, Request, File, UploadFile, HTTPException
from .knowledge import KnowledgeQuery
from .engines import selection


def knowledge_router(settings, sandbox):
    router = APIRouter()

    @router.post('/v1/knowledge')
    async def knowledge(request: Request):
        try:
            query = KnowledgeQuery.model_validate(await request.json())
            selection(query.engine, settings)
        except (ValueError, TypeError):
            raise HTTPException(422, 'Invalid or disabled knowledge query') from None
        return await sandbox(request, {'operation': 'knowledge', 'query': query.model_dump()})

    @router.post('/v1/knowledge/decode')
    async def decode(request: Request, file: UploadFile = File(...)):
        data = await file.read(settings.max_file_bytes + 1)
        await file.close()
        if len(data) > settings.max_file_bytes:
            raise HTTPException(413, 'File exceeds decoding limit')
        return await sandbox(request, {'operation': 'knowledge_decode', 'data': base64.b64encode(data).decode('ascii'), 'filename': file.filename or '', 'mime': file.content_type or ''})

    return router
