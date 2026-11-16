"""Frozen contracts for the Opera AI pipeline.

This file is the integration boundary. Every stage, route, and agent codes
against these types. Changing a field here changes every consumer, so treat
edits as a coordinated migration rather than a local tweak.

Design rules encoded here:
  - Part numbers and manual page references come from the manual, never from
    free-form model text. Every claim carries `manual_pages`.
  - The model is allowed to abstain. `RepairSummary.abstained` is a first-class
    outcome, not a failure.
  - The DIY/technician verdict is set by deterministic rules in
    `app.pipeline.safety`, never by the model alone.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------
# Enums
# --------------------------------------------------------------------------


class AssetRole(str, Enum):
    """What an uploaded file is meant to show."""

    NAMEPLATE = "nameplate"
    INTERIOR = "interior"
    VIDEO = "video"
    OTHER = "other"


class AssetStatus(str, Enum):
    AWAITING_UPLOAD = "awaiting_upload"
    UPLOADED = "uploaded"
    READY = "ready"
    FAILED = "failed"


class IdentityLevel(str, Enum):
    """How precisely the appliance was identified.

    Drives how much the downstream stages are allowed to assert. `TYPE_ONLY`
    means no manual was resolved, so diagnosis is ungrounded and must say so.
    """

    EXACT = "exact"
    SERIES = "series"
    BRAND_PLUS_TYPE = "brand_plus_type"
    TYPE_ONLY = "type_only"


class HazardClass(str, Enum):
    GAS = "gas"
    HIGH_VOLTAGE = "high_voltage"
    SEALED_REFRIGERANT = "sealed_refrigerant"
    WATER_HEATER = "water_heater"
    COMBUSTION_VENTING = "combustion_venting"
    NONE = "none"


class Verdict(str, Enum):
    DIY = "diy"
    TECHNICIAN = "technician"


class StageName(str, Enum):
    PREPROCESS = "preprocess"
    IDENTIFY = "identify"
    DIAGNOSE = "diagnose"
    PARTS = "parts"
    INSTRUCT = "instruct"


class StageStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class CaseStatus(str, Enum):
    CREATED = "created"
    AWAITING_UPLOAD = "awaiting_upload"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


# --------------------------------------------------------------------------
# Stage 1 - identify
# --------------------------------------------------------------------------


class ApplianceIdentity(BaseModel):
    """Output of the identify stage.

    `model_number` is what was read off the plate; `model_normalized` is the
    uppercased, punctuation-stripped form used for catalog lookup. `unit_number`
    is the fuller variant some plates carry (e.g. 59SC6A060M17--16), which is
    what actually keys the size-specific tables in a manual.
    """

    brand: Optional[str] = None
    model_number: Optional[str] = None
    unit_number: Optional[str] = None
    model_normalized: Optional[str] = None
    serial: Optional[str] = None
    appliance_type: Optional[str] = None

    confidence: float = Field(ge=0.0, le=1.0, default=0.0)
    identity_level: IdentityLevel = IdentityLevel.TYPE_ONLY

    # Set by catalog validation, not by the model.
    manual_id: Optional[str] = None
    catalog_matched: bool = False

    # True when the user typed or confirmed the model rather than us reading it.
    user_confirmed: bool = False

    notes: Optional[str] = None


# --------------------------------------------------------------------------
# Stage 2 - diagnose
# --------------------------------------------------------------------------


class Cause(BaseModel):
    """One candidate explanation for the reported symptom."""

    summary: str
    detail: Optional[str] = None
    confidence: float = Field(ge=0.0, le=1.0)

    # Pages in the resolved manual that support this cause. Empty means the
    # claim is ungrounded and must be presented as such.
    manual_pages: list[int] = Field(default_factory=list)

    # Free text quoted or paraphrased from those pages, used by the verifier.
    evidence: list[str] = Field(default_factory=list)

    # Error / status codes this cause is associated with, if any.
    error_codes: list[str] = Field(default_factory=list)

    # Components implicated, by the manual's own naming.
    components: list[str] = Field(default_factory=list)

    # Set by the verification pass.
    verified: Optional[bool] = None


class SafetyAssessment(BaseModel):
    """Set by deterministic rules in app.pipeline.safety, not by the model."""

    verdict: Verdict
    hazards: list[HazardClass] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    # Quoted scope language from the manual, when available.
    manual_scope_note: Optional[str] = None
    manual_pages: list[int] = Field(default_factory=list)


class RepairSummary(BaseModel):
    """Stage output: what is probably wrong, and whether the user should touch it."""

    symptom_restated: str
    causes: list[Cause] = Field(default_factory=list)
    safety: Optional[SafetyAssessment] = None

    # Honest outcome when evidence is insufficient. Not a failure.
    abstained: bool = False
    abstain_reason: Optional[str] = None

    # The two-phase hook: questions worth asking, and photos worth requesting,
    # before committing to a diagnosis.
    clarifying_questions: list[str] = Field(default_factory=list)
    requested_photos: list[str] = Field(default_factory=list)

    # True when no manual was resolved and the answer is general knowledge.
    grounded: bool = False

    @property
    def top_cause(self) -> Optional[Cause]:
        return max(self.causes, key=lambda c: c.confidence, default=None)


# --------------------------------------------------------------------------
# Stage 3 - parts
# --------------------------------------------------------------------------


class Part(BaseModel):
    """A component implicated in the repair.

    `part_number` is null unless the manual actually printed one. `search_url`
    is constructed by our code from brand + model + name - never emitted by
    the model, because hallucinated URLs look identical to real ones.
    """

    name: str
    part_number: Optional[str] = None
    manual_pages: list[int] = Field(default_factory=list)
    search_url: Optional[str] = None
    note: Optional[str] = None


class PartsList(BaseModel):
    parts: list[Part] = Field(default_factory=list)
    # True when the source manual is an installation manual with a parts *group*
    # list rather than a numbered catalog, so numbers are mostly unavailable.
    numbers_unavailable: bool = False


# --------------------------------------------------------------------------
# Stage 4 - instruct
# --------------------------------------------------------------------------


class Step(BaseModel):
    index: int
    instruction: str
    caution: Optional[str] = None
    tools: list[str] = Field(default_factory=list)
    manual_pages: list[int] = Field(default_factory=list)
    # A figure reference from the manual ("Fig. 68") when one applies.
    figure_ref: Optional[str] = None
    # Resolved by app.pipeline.illustrations: a storage key or null. Never a
    # photorealistic render of the user's appliance.
    illustration_key: Optional[str] = None


class RepairInstructions(BaseModel):
    steps: list[Step] = Field(default_factory=list)
    safety_notes: list[str] = Field(default_factory=list)
    # Populated instead of steps when the safety verdict is TECHNICIAN.
    technician_brief: Optional[str] = None


# --------------------------------------------------------------------------
# Pipeline plumbing
# --------------------------------------------------------------------------


class StageResult(BaseModel):
    """What a stage hands back to the runner. Persisted to stage_runs.output."""

    stage: StageName
    status: StageStatus
    output: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None
    # Model + token accounting, for cost tracking.
    usage: dict[str, Any] = Field(default_factory=dict)


class PipelineEvent(BaseModel):
    """Append-only progress record. The SSE endpoint replays these."""

    seq: int
    case_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: datetime


# --------------------------------------------------------------------------
# API request / response bodies
# --------------------------------------------------------------------------


class CreateCaseRequest(BaseModel):
    appliance_type_hint: Optional[str] = None


class CreateCaseResponse(BaseModel):
    case_id: str
    status: CaseStatus


class RegisterAssetRequest(BaseModel):
    filename: str
    mime_type: str
    role: AssetRole
    size_bytes: Optional[int] = None


class RegisterAssetResponse(BaseModel):
    asset_id: str
    upload_url: str
    storage_path: str
    expires_at: datetime


class SubmitInputRequest(BaseModel):
    symptom: str
    error_code: Optional[str] = None
    brand_hint: Optional[str] = None
    model_hint: Optional[str] = None


class ConfirmModelRequest(BaseModel):
    """User corrects or confirms what identify read off the nameplate.

    The cheapest reliability win in the system: a wrong model number caught
    here costs one round trip instead of an entire wrong diagnosis.
    """

    model_number: str
    brand: Optional[str] = None


class CaseView(BaseModel):
    """Full case state. What GET /api/cases/{id} returns."""

    case_id: str
    status: CaseStatus
    symptom: Optional[str] = None
    identity: Optional[ApplianceIdentity] = None
    summary: Optional[RepairSummary] = None
    parts: Optional[PartsList] = None
    instructions: Optional[RepairInstructions] = None
    assets: list[dict[str, Any]] = Field(default_factory=list)
    stages: list[dict[str, Any]] = Field(default_factory=list)
