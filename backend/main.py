"""
Field-Ops Vision Guide — FastAPI Backend
Handles the full diagnostic pipeline:
  1. /api/identify     — User sends nameplate photo → Gemini extracts model + manufacturer
  2. /api/triage       — User sends equipment media + identification → Gemini diagnoses fault
  3. /api/repair       — Confirm fault → Gemini repair steps grounded in manual
  4. /api/visual-assist — Upload step image → Cloudinary overlay
"""

import os
import json
import tempfile
import httpx

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import time
from google import genai
from instr_gen import generate_ikea_steps
from cloudinary_upload import process_media

load_dotenv()

# ── Gemini setup ──────────────────────────────────────────────────────────────
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
MODEL  = "gemini-2.5-flash"

# ── FastAPI setup ─────────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



# ── Helpers ───────────────────────────────────────────────────────────────────


def wait_for_file(gemini_file):
    while gemini_file.state.name == "PROCESSING":
        time.sleep(2)
        gemini_file = client.files.get(name=gemini_file.name)
    return gemini_file

def parse_gemini_json(response_text: str) -> dict:
    """Safely parse Gemini's response as JSON. Strips accidental markdown fences."""
    cleaned = response_text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(cleaned)


async def download_to_tempfile(url: str, suffix: str) -> str:
    """Download a remote URL to a local temp file. Returns the temp file path."""
    async with httpx.AsyncClient() as client:
        r = await client.get(url)
        r.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(r.content)
    tmp.close()
    return tmp.name


def upload_fastapi_file_to_cloudinary(upload_file: UploadFile) -> dict:
    """Save an UploadFile to a temp path, run through Cloudinary pipeline, return result."""
    suffix = os.path.splitext(upload_file.filename)[1] or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(upload_file.file.read())
        tmp_path = tmp.name
    return process_media(tmp_path)


# ── Hardcoded paths for testing ───────────────────────────────────────────────
MEDIA_PATH  = "videos/reddit_hvacadvice_wwvjkj.mp4"
MANUAL_PATH = "manuals/24ACC6-9PD.pdf"


# ── Route 1: Identify ─────────────────────────────────────────────────────────

@app.post("/api/identify")
async def identify():
    """
    Dedicated nameplate photo → Gemini extracts manufacturer, model, equipment type.
    Guaranteed clean extraction since the user is explicitly pointing at the label.
    """
    cloudinary_result = process_media(MEDIA_PATH)
    optimized_url     = cloudinary_result["optimized_url"]
    media_type        = cloudinary_result["type"]

    suffix      = ".mp4" if media_type == "video" else ".jpg"
    tmp_path    = await download_to_tempfile(optimized_url, suffix)
    gemini_file = client.files.upload(file=tmp_path)
    gemini_file = wait_for_file(gemini_file)

    identify_prompt = """
You are an expert HVAC and appliance technician.
The user has sent you a dedicated close-up photo of the equipment nameplate or label.
Extract the model number, manufacturer, and equipment type directly from what you see.

CRITICAL: Return only raw valid JSON. No markdown. No backticks. No explanation.
Return null only if a field is genuinely not visible in the image.

{
  "equipment_type": "...",
  "manufacturer": "... or null",
  "model_number": "... or null"
}
"""

    response       = client.models.generate_content(
        model=MODEL,
        contents=[gemini_file, identify_prompt],
    )
    identification = parse_gemini_json(response.text)

    return {
        "status": "success",
        "identification": identification,
        "gemini_nameplate_file_uri": gemini_file.uri,
        "cloudinary": cloudinary_result,
    }


# ── Route 2: Triage ───────────────────────────────────────────────────────────

class TriageRequest(BaseModel):
    identification: dict  # full identification object from /api/identify


@app.post("/api/triage")
async def triage(request: TriageRequest):
    """
    Fault media + identification → Gemini diagnoses fault + returns probing question.
    """
    cloudinary_result  = process_media(MEDIA_PATH)
    optimized_url      = cloudinary_result["optimized_url"]
    media_type         = cloudinary_result["type"]

    suffix             = ".mp4" if media_type == "video" else ".jpg"
    tmp_path           = await download_to_tempfile(optimized_url, suffix)
    gemini_media_file  = client.files.upload(file=tmp_path)
    gemini_media_file = wait_for_file(gemini_media_file)
    gemini_manual_file = client.files.upload(file=MANUAL_PATH)
    gemini_manual_file = wait_for_file(gemini_manual_file)

    diagnosis_prompt = f"""
You are an expert field technician diagnostician.

Equipment identified:
{json.dumps(request.identification, indent=2)}

You are given:
1. A video or image of the broken equipment — analyze visuals AND sounds carefully.
2. The manufacturer service manual for this model.

Your job:
- Diagnose the most likely fault based on what you see and hear.
- Cross-reference the manual to validate your diagnosis.
- Ask exactly ONE short probing question to confirm your diagnosis.

CRITICAL: Return only raw valid JSON. No markdown. No backticks. No explanation.

{{
  "sounds_detected": "description of any abnormal sounds heard",
  "visual_faults": "description of visible issues",
  "likely_fault": "...",
  "confidence": "low | medium | high",
  "probing_question": "One short question to confirm the diagnosis"
}}
"""

    response  = client.models.generate_content(
        model=MODEL,
        contents=[gemini_media_file, gemini_manual_file, diagnosis_prompt],
    )
    diagnosis = parse_gemini_json(response.text)

    return {
        "status": "success",
        "identification": request.identification,
        "diagnosis": diagnosis,
        "gemini_media_file_uri": gemini_media_file.uri,
        "gemini_manual_file_uri": gemini_manual_file.uri,
    }


# ── Route 3: Repair Steps ─────────────────────────────────────────────────────

class RepairRequest(BaseModel):
    diagnosis: dict
    probing_answer: str


@app.post("/api/repair")
async def get_repair_steps(request: RepairRequest):
    result = generate_ikea_steps(request.diagnosis, MANUAL_PATH)
    return {"status": "success", "repair": result}


# ── Route 4: Visual Assist (overlay) ─────────────────────────────────────────

@app.post("/api/visual-assist")
async def visual_assist(image: UploadFile = File(...)):
    """
    Accepts a technician photo of the current repair step.
    Uploads through Cloudinary, returns overlay URL with annotations.
    """
    cloudinary_result = upload_fastapi_file_to_cloudinary(image)
    optimized_url     = cloudinary_result["optimized_url"]

    # TODO: Send optimized_url to Gemini for fault location coordinates
    # TODO: Build Cloudinary overlay URL using returned coordinates

    return {
        "status": "success",
        "cloudinary": cloudinary_result,
        "composite_url": optimized_url,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
