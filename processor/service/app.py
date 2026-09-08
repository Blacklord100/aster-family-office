import asyncio
import base64
from dataclasses import asdict
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request
from starlette.responses import JSONResponse
from .config import Settings
from .schema import Extraction, Mode
from .engines import selection


def child_environment(tmpdir):
    # Decode/model settings travel through private stdin. Service credentials,
    # provider credentials, proxy variables and unrelated application secrets do not.
    allowed = {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR',
               'PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED'}
    return {**{key: value for key, value in os.environ.items() if key in allowed}, 'TMPDIR': tmpdir}


class BoundedAuthenticatedUpload:
    """Reject unauthorized/oversized bodies before multipart parsing; no payload logging."""
    def __init__(self, app, token: str, maximum: int):
        self.app, self.token, self.maximum = app, token, maximum

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/v1/'):
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        supplied = headers.get(b'x-processor-key', b'')
        if not hmac.compare_digest(supplied, self.token.encode()):
            return await JSONResponse({'detail': 'Unauthorized'}, status_code=401)(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body.extend(message.get('body', b''))
            if len(body) > (self.maximum if scope['path'] == '/v1/extract' else 65536):
                return await JSONResponse({'detail': 'Request too large'}, status_code=413)(scope, receive, send)
            if not message.get('more_body', False):
                break
        delivered = False
        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()
        return await self.app(scope, replay, send)


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    app = FastAPI(title='Aster Local Processor', version='1.0.0', docs_url=None, redoc_url=None)
    app.add_middleware(BoundedAuthenticatedUpload, token=settings.token, maximum=settings.max_file_bytes + 128 * 1024)
    # One document at a time per process bounds memory and local-model contention.
    processing = asyncio.Semaphore(1)

    @app.get('/healthz')
    def health():
        return {'status': 'ok'}

    async def sandbox(request: Request, payload: dict, is_test=False):
        try:
            await asyncio.wait_for(processing.acquire(), timeout=0.1)
        except TimeoutError as exc:
            raise HTTPException(503, 'Processor busy; retry with backoff') from exc
        stopped = threading.Event()
        children = []
        def stop_child():
            stopped.set()
            if children and children[0].poll() is None:
                try:
                    os.killpg(children[0].pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            def run():
                child_settings = asdict(settings)
                child_settings['token'] = 'internal-worker-has-no-http-auth'
                child_request = {**payload, 'settings': child_settings}
                with tempfile.TemporaryDirectory(prefix='aster-request-') as request_tmp:
                    child = subprocess.Popen([sys.executable, '-m', 'service.request_worker'], stdin=subprocess.PIPE,
                                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
                                             env=child_environment(request_tmp))
                    children.append(child)
                    if stopped.is_set():
                        stop_child()
                    try:
                        output, _ = child.communicate(json.dumps(child_request).encode(), timeout=140 if is_test else 590)
                    except subprocess.TimeoutExpired as exc:
                        stop_child()
                        child.communicate()
                        raise HTTPException(504, 'Document processing exceeded the 590-second deadline') from exc
                if child.returncode != 0:
                    raise HTTPException(422, 'Document processing failed within the local sandbox')
                try:
                    parsed = json.loads(output)
                    if 'inputError' in parsed:
                        raise HTTPException(422, parsed['inputError'])
                    if is_test:
                        if not isinstance(parsed, dict) or set(parsed) != {'ok', 'errorCode'} or type(parsed['ok']) is not bool or parsed['errorCode'] not in (None, 'MODEL_UNAVAILABLE', 'SCHEMA_CHECK_FAILED'):
                            raise ValueError('Invalid engine test result')
                        return parsed
                    return Extraction.model_validate(parsed)
                except ValueError as exc:
                    raise HTTPException(500, 'Local worker returned an invalid result') from exc
            task = asyncio.create_task(asyncio.to_thread(run))
            try:
                while not task.done():
                    done, _ = await asyncio.wait({task}, timeout=0.25)
                    if not done and await request.is_disconnected():
                        stop_child()
                        await asyncio.gather(task, return_exceptions=True)
                        raise HTTPException(499, 'Client disconnected; local document worker stopped')
                return await task
            except asyncio.CancelledError:
                stop_child()
                await asyncio.gather(task, return_exceptions=True)
                raise
        finally:
            processing.release()

    @app.post('/v1/extract', response_model=Extraction)
    async def extract(request: Request, file: UploadFile = File(...), mode: Mode = Form(...), document_id: str = Form(...), engine: str | None = Form(None)):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', document_id):
            raise HTTPException(422, 'document_id must be a safe opaque identifier')
        try:
            selected = selection(json.loads(engine) if engine is not None else None, settings)
        except (ValueError, TypeError):
            raise HTTPException(422, 'Invalid or disabled engine selection') from None
        data = await file.read(settings.max_file_bytes + 1)
        await file.close()
        if len(data) > settings.max_file_bytes:
            raise HTTPException(413, 'File exceeds 10 MiB')
        return await sandbox(request, {'data': base64.b64encode(data).decode('ascii'), 'filename': file.filename or '',
                           'mime': file.content_type or '', 'document_id': document_id, 'mode': mode,
                           'engine': selected.model_dump(exclude_none=True) if engine is not None else None})

    @app.post('/v1/engine-test')
    async def engine_test(request: Request):
        try:
            selected = selection(await request.json(), settings)
        except (ValueError, TypeError):
            raise HTTPException(422, 'Invalid or disabled engine selection') from None
        return await sandbox(request, {'operation': 'engine_test', 'engine': selected.model_dump(exclude_none=True)}, is_test=True)

    @app.get('/v1/models')
    async def models():
        from .engines import discover_models
        try:
            return await asyncio.to_thread(discover_models, settings)
        except Exception:
            raise HTTPException(502, 'Local model discovery unavailable') from None

    return app
