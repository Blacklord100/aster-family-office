"""Local multimodal transport and capability boundaries, without live inference."""
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from service.config import Settings
from service.engines import CloudModel, EngineSelection, SyntheticCheck
from service.ollama import LocalModelError, LocalOllama, validated_images


TOKEN = 'synthetic-local-vision-test-token'


def picture(width=20, height=12, image_format='PNG'):
    buffer = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(buffer, format=image_format)
    return base64.b64encode(buffer.getvalue()).decode('ascii')


def local_model(capabilities=None, **show_overrides):
    requests = []
    model = LocalOllama(Settings(TOKEN, ollama_model='synthetic-local:vision'))

    def handler(request):
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        assert request.url.host == '127.0.0.1'
        assert body['model'] == 'synthetic-local:vision'
        if request.url.path == '/api/show':
            return httpx.Response(200, json={'details': {'format': 'gguf'},
                                           'capabilities': capabilities, **show_overrides})
        return httpx.Response(200, json={'done': True, 'message': {'content': '{"ok":true}'}})

    model.client.close()
    model.client = httpx.Client(base_url=model.settings.ollama_base_url,
                               transport=httpx.MockTransport(handler), trust_env=False, follow_redirects=False)
    return model, requests


def test_local_vision_verifies_capability_and_sends_exact_image_with_schema():
    encoded = picture()
    model, requests = local_model(['completion', 'vision', 'tools'])
    try:
        assert model.supports_vision is False
        assert model.structured(SyntheticCheck, 'Inspect the supplied synthetic image.', images=[encoded]).ok
        assert model.supports_vision is True and model.calls == 1
        assert [path for path, _ in requests] == ['/api/show', '/api/chat']
        chat = requests[-1][1]
        assert chat['messages'][1]['images'] == [encoded]
        assert 'images' not in chat['messages'][0]
        assert chat['format'] == SyntheticCheck.model_json_schema()
        assert chat['stream'] is False and chat['think'] is False
        assert 'tools' not in chat and chat['options']['temperature'] == 0
        model.structured(SyntheticCheck, 'Second image.', images=[encoded])
        assert [path for path, _ in requests].count('/api/show') == 1
    finally:
        model.close()


@pytest.mark.parametrize('capabilities', [None, [], ['completion', 'tools'], 'vision', {'vision': True}, ['vision', 1]])
def test_unverified_or_text_only_capabilities_cannot_silently_ignore_images(capabilities):
    model, requests = local_model(capabilities)
    try:
        with pytest.raises(LocalModelError, match='^model_vision_not_supported$'):
            model.structured(SyntheticCheck, 'Image required.', images=[picture()])
        assert model.supports_vision is False and model.calls == 0
        assert [path for path, _ in requests] == ['/api/show']
    finally:
        model.close()


@pytest.mark.parametrize('metadata', [{'remote_host': 'outside.invalid'}, {'remote_model': 'other'},
                                      {'details': {'format': 'remote'}}])
def test_remote_metadata_cannot_enable_vision(metadata):
    model, requests = local_model(['vision'], **metadata)
    try:
        with pytest.raises(LocalModelError, match='model_not_verified_local_gguf'):
            model.structured(SyntheticCheck, 'Image required.', images=[picture()])
        assert model.calls == 0 and not model.supports_vision
        assert len(requests) == 1
    finally:
        model.close()


@pytest.mark.parametrize('images', [['https://outside.invalid/image.png'], ['/etc/passwd'],
                                   ['data:image/png;base64,aGVsbG8='], [''], ['%%%%'],
                                   [base64.b64encode(b'not an image').decode()],
                                   [base64.b64encode(b'<svg></svg>').decode()], [5],
                                   [picture()] * 5, 'not a list'])
def test_bad_image_input_fails_before_any_transport(images):
    model, requests = local_model(['vision'])
    try:
        with pytest.raises(LocalModelError, match='model_image_'):
            model.structured(SyntheticCheck, 'Synthetic.', images=images)
        assert model.calls == 0 and requests == []
    finally:
        model.close()


@pytest.mark.parametrize('encoded', [picture(4097, 1), picture(3000, 3000), picture(image_format='GIF')])
def test_dimension_and_format_bounds(encoded):
    with pytest.raises(LocalModelError, match='model_image_shape_invalid'):
        validated_images([encoded])


def test_per_image_and_aggregate_byte_bounds(monkeypatch):
    encoded = picture()
    count = len(base64.b64decode(encoded))
    monkeypatch.setattr('service.ollama.MAX_MODEL_IMAGE_BYTES', count - 1)
    with pytest.raises(LocalModelError, match='model_image_(encoding_invalid|bytes_exceeded)'):
        validated_images([encoded])
    monkeypatch.setattr('service.ollama.MAX_MODEL_IMAGE_BYTES', count)
    monkeypatch.setattr('service.ollama.MAX_MODEL_IMAGES_BYTES', 2 * count - 1)
    with pytest.raises(LocalModelError, match='model_image_bytes_exceeded'):
        validated_images([encoded, encoded])


def test_truncated_png_is_not_treated_as_valid_image():
    data = base64.b64decode(picture())
    with pytest.raises(LocalModelError, match='model_image_invalid'):
        validated_images([base64.b64encode(data[:50]).decode()])


def test_existing_text_path_needs_no_capability_probe_or_images_field():
    model, requests = local_model()
    try:
        assert model.structured(SyntheticCheck, 'Text only.').ok
        assert model.structured(SyntheticCheck, 'Text only.', images=[]).ok
        assert [path for path, _ in requests] == ['/api/chat', '/api/chat']
        assert all('images' not in body['messages'][1] for _, body in requests)
    finally:
        model.close()


@pytest.mark.parametrize('provider', ['openai', 'anthropic'])
def test_local_page_images_are_not_sent_to_cloud_adapter(provider):
    engine = EngineSelection(name='Synthetic cloud', provider=provider, model='synthetic',
                             apiKey='synthetic-provider-key-only')
    model = CloudModel(Settings(TOKEN, allow_cloud_engines=True), engine)
    model._request = lambda *args: pytest.fail('Unexpected provider request')
    try:
        assert not model.supports_vision
        with pytest.raises(LocalModelError, match='provider_vision_not_enabled'):
            model.structured(SyntheticCheck, 'Synthetic image.', images=[picture()])
        assert model.calls == 0
    finally:
        model.close()
