from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

Mode = Literal['workflow', 'agentic']
Kind = Literal['valuation', 'capital_call', 'distribution', 'news']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Evidence(StrictModel):
    page: int = Field(ge=1, le=60)
    quote: str = Field(min_length=8, max_length=3000)


class Fact(StrictModel):
    kind: Kind
    investmentName: str = Field(min_length=2, max_length=200)
    effectiveDate: Annotated[str, Field(pattern=r'^\d{4}-\d{2}-\d{2}$')] | None
    amount: Annotated[str, Field(pattern=r'^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$')] | None
    currency: Literal['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'CAD', 'AUD', 'SGD', 'HKD', 'CNY'] | None
    dueDate: Annotated[str, Field(pattern=r'^\d{4}-\d{2}-\d{2}$')] | None
    summary: str = Field(min_length=1, max_length=1000)
    evidence: Evidence

    @field_validator('effectiveDate', 'dueDate')
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            if len(value) != 10 or date.fromisoformat(value).isoformat() != value:
                raise ValueError('ISO calendar date required')
        return value

    @field_validator('amount')
    @classmethod
    def valid_money(cls, value):
        import re
        if value is not None and not re.fullmatch(r'-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?', value):
            raise ValueError('finite plain decimal string required')
        if value is not None and not Decimal(value).is_finite():
            raise ValueError('finite decimal required')
        return value

    @field_validator('currency')
    @classmethod
    def currency_code(cls, value):
        # A deliberately narrow supported set; symbols alone are ambiguous.
        if value not in (None, 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'CAD', 'AUD', 'SGD', 'HKD', 'CNY'):
            raise ValueError('unsupported currency code')
        return value


class Trace(StrictModel):
    stage: str
    status: Literal['ok', 'skipped', 'warning', 'error']
    detail: str


class Extraction(StrictModel):
    schemaVersion: Literal[1] = 1
    documentId: str
    mode: Mode
    execution: Literal['local', 'cloud'] = 'local'
    documentType: str
    relevant: bool
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    facts: list[Fact] = Field(max_length=100)
    warnings: list[str]
    trace: list[Trace]
    model: str | None


class ModelFacts(StrictModel):
    facts: list[Fact] = Field(max_length=30)


class SourceReference(StrictModel):
    page: int = Field(ge=1, le=60)
    sourceId: str = Field(min_length=1, max_length=80)


class ReferencedFact(Fact):
    """Internal proposal; only the application can turn a source ID into evidence."""
    evidence: SourceReference


class ReferencedModelFacts(ModelFacts):
    # Exact-quote legacy responses remain independently validated. The schema
    # sent to new model calls requests source IDs, avoiding quote transcription.
    facts: list[ReferencedFact | Fact] = Field(max_length=30)


class AgentAction(StrictModel):
    action: Literal['read_page', 'search', 'inspect_layout', 'inspect_image', 'extract', 'review_coverage', 'finish']
    page: int | None
    query: str | None = Field(default=None, min_length=1, max_length=160)
