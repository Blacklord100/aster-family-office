from dataclasses import dataclass
import os
import re
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    token: str
    ollama_base_url: str = 'http://127.0.0.1:11434'
    ollama_model: str = 'qwen3:1.7b'
    ollama_timeout: float = 120
    max_agent_steps: int = 32
    max_model_calls: int = 64
    max_page_extractions: int = 2
    max_file_bytes: int = 10 * 1024 * 1024
    max_pages: int = 40
    max_text_chars: int = 120_000
    ocr_enabled: bool = True
    max_ocr_pages: int = 4
    visual_pages_enabled: bool = True
    max_visual_pages: int = 6
    max_visual_bytes: int = 8 * 1024 * 1024
    max_nested_eml_depth: int = 3
    max_email_parts: int = 32
    max_email_attachments: int = 8
    document_decode_timeout_seconds: float = 75
    allow_cloud_engines: bool = False

    def __post_init__(self):
        if len(self.token) < 24:
            raise ValueError('PROCESSOR_TOKEN must contain at least 24 characters')
        normalized_token = self.token.strip().upper().replace('-', '_')
        if normalized_token.startswith(('REPLACE_', 'CHANGE_ME', 'CHANGEME', 'TODO')):
            raise ValueError('PROCESSOR_TOKEN must be a generated secret, not a placeholder')
        u = urlsplit(self.ollama_base_url)
        # Fixed deployment endpoints only. No caller-supplied destinations.
        if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1', 'ollama', 'host.docker.internal'):
            raise ValueError('Ollama endpoint must be an approved local HTTP host')
        if u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
            raise ValueError('Ollama endpoint must be a bare local origin')
        if u.port is not None and not 1 <= u.port <= 65535:
            raise ValueError('Invalid local endpoint port')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,120}', self.ollama_model) or 'cloud' in self.ollama_model.lower():
            raise ValueError('Only explicitly configured local model tags are permitted')
        if (not 1 <= self.max_agent_steps <= 64 or not 1 <= self.ollama_timeout <= 180
                or not 1 <= self.max_model_calls <= 96 or not 1 <= self.max_page_extractions <= 3):
            raise ValueError('Invalid inference bounds')
        if (not 0 <= self.max_visual_pages <= 12 or not 0 <= self.max_visual_bytes <= 16 * 1024 * 1024
                or not 0 <= self.max_nested_eml_depth <= 5 or not 1 <= self.max_email_parts <= 64
                or not 1 <= self.max_email_attachments <= 16 or not 1 <= self.document_decode_timeout_seconds <= 120):
            raise ValueError('Invalid document tool bounds')

    @classmethod
    def from_env(cls):
        return cls(token=os.environ.get('PROCESSOR_TOKEN', ''),
                   ollama_base_url=os.environ.get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').rstrip('/'),
                   ollama_model=os.environ.get('OLLAMA_MODEL', 'qwen3:1.7b'),
                   ollama_timeout=float(os.environ.get('OLLAMA_TIMEOUT_SECONDS', '120')),
                   max_agent_steps=int(os.environ.get('MAX_AGENT_STEPS', '32')),
                   max_model_calls=int(os.environ.get('MAX_MODEL_CALLS', '64')),
                   max_page_extractions=int(os.environ.get('MAX_PAGE_EXTRACTIONS', '2')),
                   ocr_enabled=os.environ.get('OCR_ENABLED', 'true').lower() == 'true',
                   visual_pages_enabled=os.environ.get('VISUAL_PAGES_ENABLED', 'true').lower() == 'true',
                   max_visual_pages=int(os.environ.get('MAX_VISUAL_PAGES', '6')),
                   max_visual_bytes=int(os.environ.get('MAX_VISUAL_BYTES', str(8 * 1024 * 1024))),
                   max_nested_eml_depth=int(os.environ.get('MAX_NESTED_EML_DEPTH', '3')),
                   max_email_parts=int(os.environ.get('MAX_EMAIL_PARTS', '32')),
                   max_email_attachments=int(os.environ.get('MAX_EMAIL_ATTACHMENTS', '8')),
                   document_decode_timeout_seconds=float(os.environ.get('DOCUMENT_DECODE_TIMEOUT_SECONDS', '75')),
                   allow_cloud_engines=os.environ.get('ALLOW_CLOUD_ENGINES', 'false') == 'true')
