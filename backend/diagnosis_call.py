"""
Call 1 — Diagnosis (MVP implementation, Gemini)

Takes a local equipment image or video file plus the technician's transcribed
description, sends the media directly to Gemini along with the description,
and returns a structured JSON diagnosis.

Usage (CLI MVP):
    python diagnosis_call.py path/to/media.mp4 "Technician description..."

Environment:
    - GEMINI_API_KEY for the JSON+vision model
    - Optional: GEMINI_MODEL (defaults to "models/gemini-1.5-pro")
"""

import json
import os
import sys
from typing import Any, Dict, TypedDict

from dotenv import load_dotenv

try:
    import google.generativeai as genai
except ImportError as e:  # pragma: no cover - import-time guard
    raise SystemExit(
        "The 'google-generativeai' package is required for diagnosis_call.py.\n"
        "Install it with:\n\n"
        "    pip install google-generativeai\n"
    ) from e


load_dotenv()


GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "models/gemini-1.5-pro")


ALLOWED_EQUIPMENT_TYPES = {
    "furnace",
    "air_handler",
    "boiler",
    "heat_pump",
    "rooftop_unit",
    "mini_split",
    "unknown",
}

ALLOWED_CONFIDENCE_VALUES = {"low", "medium", "high"}


class DiagnosisResult(TypedDict):
    equipment_type: str
    model_number: str
    manufacturer: str
    sounds_detected: str
    likely_fault: str
    confidence: str
    probing_question: str


SYSTEM_PROMPT = """
You are a senior HVAC and mechanical systems diagnostic assistant.

You receive:
- Visual evidence of equipment (photos or videos that may include sound)
- A technician's transcribed description of the issue (including any sounds they mention)

Your job:
1. Infer the single most likely fault based on all available evidence (visuals + any audible equipment sounds + the technician description).
2. Be realistic and conservative, like an experienced field technician.
3. Ask exactly one short probing yes/no-style question to help confirm or reject your hypothesis.

Important input details:
- Treat the technician's description as the primary source of truth for sounds and symptoms.
- Use the media to infer equipment type, manufacturer branding, model numbers, LEDs, flames, error codes, and other visible failure clues.

Output format requirements (critical):
- Respond with a single JSON object only.
- Do not include markdown, explanations, comments, or extra keys.
- All values must be strings.
- Never return null, empty strings, or omit fields.
- If a field cannot be determined, use the string "unknown" (never null or empty).
- The field `confidence` must be one of: "low", "medium", "high".
- The field `equipment_type` should be one of:
  "furnace", "air_handler", "boiler", "heat_pump", "rooftop_unit", "mini_split", or "unknown".
- The field `probing_question` must be a single, concrete yes/no-style question a technician can answer on site.

Target JSON shape:
{
  "equipment_type": "furnace",
  "model_number": "59SC5A",
  "manufacturer": "Carrier",
  "sounds_detected": "clicking every 3 seconds on startup",
  "likely_fault": "faulty flame sensor",
  "confidence": "high",
  "probing_question": "Does the furnace attempt to ignite and then shut off after a few seconds?"
}
""".strip()


def normalize_string(value: Any) -> str:
    if value is None:
        return "unknown"
    if not isinstance(value, str):
        try:
            value = str(value)
        except Exception:
            return "unknown"
    value = value.strip()
    return value if value else "unknown"


def normalize_diagnosis(raw: Dict[str, Any]) -> DiagnosisResult:
    """
    Enforce schema rules and fill in unknowns.
    """
    equipment_type = normalize_string(raw.get("equipment_type")).lower()
    if equipment_type not in ALLOWED_EQUIPMENT_TYPES:
        equipment_type = "unknown"

    confidence = normalize_string(raw.get("confidence")).lower()
    if confidence not in ALLOWED_CONFIDENCE_VALUES:
        # Treat any invalid or missing confidence as "low" (conservative fallback)
        confidence = "low"

    model_number = normalize_string(raw.get("model_number"))
    manufacturer = normalize_string(raw.get("manufacturer"))
    sounds_detected = normalize_string(raw.get("sounds_detected"))
    likely_fault = normalize_string(raw.get("likely_fault"))
    probing_question = normalize_string(raw.get("probing_question"))

    return DiagnosisResult(
        equipment_type=equipment_type,
        model_number=model_number,
        manufacturer=manufacturer,
        sounds_detected=sounds_detected,
        likely_fault=likely_fault,
        confidence=confidence,
        probing_question=probing_question,
    )


def call_diagnosis_model(
    media_file_path: str,
    technician_description: str,
) -> DiagnosisResult:
    """
    Call the Gemini JSON+vision model and return the normalized diagnosis object.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing GEMINI_API_KEY in environment. Set it in your .env file."
        )

    if not os.path.exists(media_file_path):
        raise FileNotFoundError(f"Media file not found: {media_file_path}")

    genai.configure(api_key=api_key)

    model = genai.GenerativeModel(
        GEMINI_MODEL,
        generation_config={"response_mime_type": "application/json"},
    )

    prompt = (
        SYSTEM_PROMPT
        + "\n\nTechnician transcribed description of the issue:\n"
        + technician_description.strip()
        + "\n\nUse the attached media (visuals and any equipment sounds) together "
        "with this description to produce the JSON diagnosis."
    )

    # Upload the local media file (image or video) so Gemini can inspect it directly.
    uploaded_media = genai.upload_file(media_file_path)

    response = model.generate_content([prompt, uploaded_media])
    raw = response.text or "{}"

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(
            "Gemini did not return valid JSON. Raw content:\n" + raw
        )

    return normalize_diagnosis(parsed)


def run_cli() -> None:
    """
    CLI entry point for quick testing of Call 1 — Diagnosis.

    Example:
        python diagnosis_call.py ./samples/furnace_startup.mp4 \\
            "On startup the inducer runs, I hear a click, but the burners never light."
    """
    if len(sys.argv) < 3:
        print("Usage: python diagnosis_call.py <media_file_path> <technician_description>")
        print("  Example:")
        print(
            '    python diagnosis_call.py ./furnace.mp4 '
            '"On startup it clicks every few seconds and never lights."'
        )
        raise SystemExit(1)

    media_file_path = sys.argv[1]
    technician_description = " ".join(sys.argv[2:]).strip()

    print(f"Sending media file to Gemini diagnosis model: {media_file_path}")
    diagnosis = call_diagnosis_model(media_file_path, technician_description)

    print("\n" + "=" * 60)
    print("Diagnosis JSON")
    print("=" * 60)
    print(json.dumps(diagnosis, indent=2))


if __name__ == "__main__":
    run_cli()

