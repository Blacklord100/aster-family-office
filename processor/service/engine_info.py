"""Bounded local metadata inspection; never generation or provider API access."""
from dataclasses import replace
from datetime import datetime, timezone
import re
from typing import Literal
import httpx

from pydantic import Field, model_validator

from .engines import discover_models
from .ollama import LocalOllama, LocalModelError, MODEL_CONTEXT_TOKENS, MODEL_OUTPUT_TOKENS, MAX_MODEL_PROMPT_BYTES
from .runtime_limits import DOCUMENT_TIMEOUT_SECONDS
from .schema import StrictModel


class InspectionVision(StrictModel):
    advertised: Literal['supported', 'unsupported', 'unknown']
    effective: Literal['enabled', 'model_unsupported', 'metadata_unknown', 'deployment_disabled', 'provider_disabled']
    basis: Literal['local_metadata', 'provider_policy']
    imageTested: Literal[False] = False


class InspectionLimits(StrictModel):
    maxFileBytes: int = Field(ge=1)
    maxPages: int = Field(ge=1)
    maxTextCharacters: int = Field(ge=1)
    ocrEnabled: bool
    maxOcrPages: int = Field(ge=0)
    maxNestedEmailDepth: int = Field(ge=0, le=5)
    maxEmailParts: int = Field(ge=1, le=64)
    maxEmailAttachments: int = Field(ge=1, le=16)
    visualPagesEnabled: bool
    maxVisualPages: int = Field(ge=0, le=12)
    maxVisualBytes: int = Field(ge=0, le=16 * 1024 * 1024)
    maxAgentSteps: int = Field(ge=1, le=64)
    maxModelCalls: int = Field(ge=1, le=96)
    maxPageExtractions: int = Field(ge=1, le=3)
    decodeTimeoutSeconds: float = Field(ge=1, le=120)
    documentTimeoutSeconds: int = Field(ge=1)
    contextTokens: int | None = Field(ge=1)
    outputTokens: int | None = Field(ge=1)
    maxPromptBytes: int | None = Field(ge=1)


class EngineInfo(StrictModel):
    provider: Literal['ollama', 'openai', 'anthropic']
    model: str = Field(min_length=1, max_length=121, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:/-]*$')
    execution: Literal['local', 'cloud']
    checkedAt: str = Field(max_length=40)
    vision: InspectionVision
    observedDigest: str | None = Field(pattern=r'^(?:sha256:)?[a-f0-9]{64}$')
    digestPinned: Literal[False] = False
    limits: InspectionLimits
    autoDownload: Literal[False] = False
    generationPerformed: Literal[False] = False

    @model_validator(mode='after')
    def boundary(self):
        if (self.provider == 'ollama') != (self.execution == 'local'):
            raise ValueError('Invalid execution identity')
        if self.execution == 'cloud' and (self.vision.basis != 'provider_policy' or self.vision.effective != 'provider_disabled'
                                         or self.observedDigest is not None or self.vision.advertised != 'unknown'):
            raise ValueError('Invalid cloud inspection')
        if self.execution == 'local':
            enabled = self.limits.visualPagesEnabled and self.limits.maxVisualPages > 0 and self.limits.maxVisualBytes > 0
            expected = ('deployment_disabled' if not enabled else 'enabled' if self.vision.advertised == 'supported'
                        else 'model_unsupported' if self.vision.advertised == 'unsupported' else 'metadata_unknown')
            if self.vision.basis != 'local_metadata' or self.vision.effective != expected:
                raise ValueError('Invalid local image enablement')
        return self


def inspect_engine(settings, engine):
    local = engine.execution == 'local'
    digest = None
    advertised = 'unknown'
    if local:
        # The disposable inspection process has its own 20-second total wall
        # deadline; each bounded metadata request has a short inactivity bound.
        metadata_settings = replace(settings, ollama_model=engine.model, ollama_timeout=5)
        model = LocalOllama(metadata_settings)
        try:
            model.verify_local()
            if model.capabilities_known:
                advertised = 'supported' if model.supports_vision else 'unsupported'
            # An exact /api/tags alias match is an observation, never a pin.
            # Absence, duplicate aliases or a failed digest lookup stays unknown.
            try:
                matches = [row for row in discover_models(metadata_settings)['models'] if row['name'] == engine.model]
                if len(matches) == 1 and re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}', matches[0]['digest']):
                    digest = matches[0]['digest']
            except (LocalModelError, ValueError, TypeError, httpx.HTTPError):
                pass
        finally:
            model.close()
    enabled = settings.visual_pages_enabled and settings.max_visual_pages > 0 and settings.max_visual_bytes > 0
    effective = ('provider_disabled' if not local else 'deployment_disabled' if not enabled else
                 'enabled' if advertised == 'supported' else 'model_unsupported' if advertised == 'unsupported' else 'metadata_unknown')
    return EngineInfo(provider=engine.provider, model=engine.model, execution=engine.execution,
                      checkedAt=datetime.now(timezone.utc).isoformat(), observedDigest=digest,
                      vision=InspectionVision(advertised=advertised, effective=effective,
                                              basis='local_metadata' if local else 'provider_policy'),
                      limits=InspectionLimits(maxFileBytes=settings.max_file_bytes, maxPages=settings.max_pages,
                          maxTextCharacters=settings.max_text_chars, ocrEnabled=settings.ocr_enabled,
                          maxOcrPages=settings.max_ocr_pages, visualPagesEnabled=settings.visual_pages_enabled,
                          maxNestedEmailDepth=settings.max_nested_eml_depth, maxEmailParts=settings.max_email_parts,
                          maxEmailAttachments=settings.max_email_attachments,
                          maxVisualPages=settings.max_visual_pages, maxVisualBytes=settings.max_visual_bytes,
                          maxAgentSteps=settings.max_agent_steps, maxModelCalls=settings.max_model_calls,
                          maxPageExtractions=settings.max_page_extractions,
                          decodeTimeoutSeconds=settings.document_decode_timeout_seconds,
                          documentTimeoutSeconds=DOCUMENT_TIMEOUT_SECONDS,
                          contextTokens=MODEL_CONTEXT_TOKENS if local else None,
                          outputTokens=MODEL_OUTPUT_TOKENS,
                          maxPromptBytes=MAX_MODEL_PROMPT_BYTES if local else None))
