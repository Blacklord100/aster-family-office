"""Fixed-origin model adapters. Credentials never become model prompts or outputs."""
import json
import re
from dataclasses import replace
from typing import Literal
import httpx
from pydantic import BaseModel, Field, field_validator, model_validator
from .config import Settings
from .schema import StrictModel, ModelFacts, Fact
from .ollama import LocalOllama, LocalModelError, SYSTEM


class EngineSelection(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    provider: Literal['ollama', 'openai', 'anthropic']
    model: str = Field(min_length=1, max_length=121, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:/-]*$')
    apiKey: str | None = Field(default=None, repr=False)

    @field_validator('apiKey')
    @classmethod
    def key_shape(cls, value):
        if value is not None and (not 16 <= len(value) <= 4096 or not re.fullmatch(r'[\x21-\x7e]+', value)):
            raise ValueError('Invalid provider credential')
        return value

    @model_validator(mode='after')
    def provider_shape(self):
        if self.provider == 'ollama' and (self.apiKey or 'cloud' in self.model.lower()):
            raise ValueError('Local model credentials or cloud aliases are prohibited')
        if self.provider != 'ollama' and not self.apiKey:
            raise ValueError('Cloud credential is required')
        return self

    @property
    def execution(self):
        return 'local' if self.provider == 'ollama' else 'cloud'


def selection(value, settings):
    engine = EngineSelection.model_validate(value) if value is not None else EngineSelection(name='Deployment default', provider='ollama', model=settings.ollama_model)
    if engine.execution == 'cloud' and not settings.allow_cloud_engines:
        raise ValueError('Cloud engines disabled by deployment')
    return engine


def cloud_schema(schema):
    """Portable constrained-output subset; original strict schema validates afterwards."""
    def transform(node):
        if isinstance(node, list):
            return [transform(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = {key: transform(value) for key, value in node.items()
                  if key not in {'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format', 'default', 'title'}}
        if 'const' in result:
            result['enum'] = [result.pop('const')]
        if result.get('type') == 'object':
            result['additionalProperties'] = False
            result['required'] = list(result.get('properties', {}))
        return result
    inner = transform(schema)
    definitions = inner.pop('$defs', None)
    wrapper = {'type': 'object', 'properties': {'result': inner}, 'required': ['result'], 'additionalProperties': False}
    if definitions:
        wrapper['$defs'] = definitions
    return wrapper


class CloudModel:
    def __init__(self, settings: Settings, engine: EngineSelection):
        if not settings.allow_cloud_engines or engine.execution != 'cloud':
            raise LocalModelError('cloud_engine_disabled')
        self.settings, self.engine = settings, engine
        self.calls, self.rejected_candidates = 0, 0
        self.client = httpx.Client(timeout=httpx.Timeout(settings.ollama_timeout, connect=5), trust_env=False, follow_redirects=False)

    def close(self):
        self.client.close()

    def verify_local(self):
        # Common adapter lifecycle; cloud authorization was checked at construction.
        return None

    def _request(self, url, headers, body):
        try:
            with self.client.stream('POST', url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    raise LocalModelError('provider_http_error')
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > 2 * 1024 * 1024:
                        raise LocalModelError('provider_response_too_large')
            result = json.loads(data)
            if not isinstance(result, dict):
                raise LocalModelError('provider_invalid_response')
            return result
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise LocalModelError('provider_unavailable_or_invalid_json') from exc

    def structured(self, schema: type[BaseModel], prompt: str, output_schema: dict | None = None):
        self.calls += 1
        required = cloud_schema(output_schema or schema.model_json_schema())
        prompt += '\nReturn the required JSON object with result containing the requested answer.'
        if self.engine.provider == 'openai':
            result = self._request('https://api.openai.com/v1/responses', {'Authorization': 'Bearer ' + self.engine.apiKey}, {
                'model': self.engine.model, 'store': False, 'max_output_tokens': 3200,
                'input': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}],
                'text': {'format': {'type': 'json_schema', 'name': 'aster_output', 'strict': True, 'schema': required}},
            })
            if result.get('status') != 'completed':
                raise LocalModelError('provider_incomplete_or_refused')
            output = result.get('output')
            if not isinstance(output, list) or len(output) > 32 or not all(isinstance(item, dict) for item in output):
                raise LocalModelError('provider_invalid_response')
            if any(item.get('type') not in ('message', 'reasoning') for item in output):
                raise LocalModelError('provider_unexpected_tool_output')
            messages = [item for item in output if item.get('type') == 'message']
            if len(messages) != 1 or not isinstance(messages[0].get('content'), list):
                raise LocalModelError('provider_invalid_response')
            blocks = messages[0]['content']
            if not all(isinstance(block, dict) for block in blocks):
                raise LocalModelError('provider_invalid_response')
            if any(block.get('type') != 'output_text' for block in blocks) or len(blocks) != 1:
                raise LocalModelError('provider_incomplete_or_refused')
            content = blocks[0].get('text')
        else:
            result = self._request('https://api.anthropic.com/v1/messages', {'x-api-key': self.engine.apiKey, 'anthropic-version': '2023-06-01'}, {
                'model': self.engine.model, 'max_tokens': 3200, 'system': SYSTEM,
                'messages': [{'role': 'user', 'content': prompt}],
                'output_config': {'format': {'type': 'json_schema', 'schema': required}},
            })
            blocks = result.get('content', [])
            if not isinstance(blocks, list) or len(blocks) != 1 or not isinstance(blocks[0], dict):
                raise LocalModelError('provider_invalid_response')
            if result.get('stop_reason') != 'end_turn' or blocks[0].get('type') != 'text':
                raise LocalModelError('provider_incomplete_or_refused')
            content = blocks[0].get('text')
        try:
            envelope = json.loads(content)
            if not isinstance(envelope, dict) or set(envelope) != {'result'}:
                raise ValueError('Unexpected output envelope')
            value = envelope['result']
            try:
                return schema.model_validate(value)
            except (ValueError, TypeError):
                if schema is ModelFacts and isinstance(value, dict) and set(value) == {'facts'} and isinstance(value['facts'], list) and len(value['facts']) <= 30:
                    valid = []
                    for item in value['facts']:
                        try:
                            valid.append(Fact.model_validate(item))
                        except (ValueError, TypeError):
                            self.rejected_candidates += 1
                    return ModelFacts(facts=valid)
                raise
        except (ValueError, TypeError) as exc:
            raise LocalModelError('model_schema_invalid') from exc


def model_client(settings: Settings, engine: EngineSelection):
    if engine.provider == 'ollama':
        return LocalOllama(replace(settings, ollama_model=engine.model))
    return CloudModel(settings, engine)


class SyntheticCheck(StrictModel):
    ok: Literal[True]


def test_engine(settings, engine):
    model = model_client(settings, engine)
    try:
        model.verify_local()
        model.structured(SyntheticCheck, 'SYNTHETIC CONNECTIVITY TEST ONLY. Return ok as true. No document or portfolio data is included.')
        return {'ok': True, 'errorCode': None}
    except LocalModelError as exc:
        return {'ok': False, 'errorCode': 'SCHEMA_CHECK_FAILED' if str(exc) == 'model_schema_invalid' else 'MODEL_UNAVAILABLE'}
    finally:
        model.close()


def discover_models(settings):
    with httpx.Client(timeout=httpx.Timeout(10, connect=3), trust_env=False, follow_redirects=False) as client:
        with client.stream('GET', settings.ollama_base_url + '/api/tags') as response:
            if response.status_code != 200:
                raise LocalModelError('local_discovery_failed')
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > 131072:
                    raise LocalModelError('local_discovery_too_large')
        value = json.loads(data)
        models = value.get('models')
        if not isinstance(models, list) or len(models) > 100:
            raise LocalModelError('local_discovery_invalid')
        result = []
        for item in models:
            if not isinstance(item, dict) or item.get('remote_host') or item.get('remote_model') or item.get('details', {}).get('format') != 'gguf':
                continue
            name, size, digest = item.get('name'), item.get('size'), item.get('digest')
            if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,120}', name) or 'cloud' in name.lower():
                continue
            if type(size) is not int or size < 0 or not isinstance(digest, str) or len(digest) > 200:
                continue
            result.append({'name': name, 'size': size, 'digest': digest})
        return {'models': result}
