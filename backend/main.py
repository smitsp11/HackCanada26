import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles # <-- CRUCIAL FOR AUDIO
from pydantic import BaseModel

# --- YOUR NEW IMPORTS ---
# Make sure instr_gen.py and voice_gen.py are in the same folder as this file
from instr_gen import generate_ikea_steps
from voice_gen import generate_step_audio

app = FastAPI()

# 1. The Anti-Blocker: Allow Next.js to talk to FastAPI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- CRUCIAL ADDITION: Serve the audio files to the frontend ---
# This allows Next.js to fetch http://localhost:8000/assets/audio/steps/step_1.mp3
os.makedirs("assets", exist_ok=True)
app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# 2. Data Schemas
class TriageRequest(BaseModel):
    media_url: str
    equipment_model: str

class DiagnosisRequest(BaseModel):
    equipment: str
    fault: str

# 3. Step 1: The Initial Audio/Video Diagnostic (Unchanged)
@app.post("/api/triage")
async def initial_triage(request: TriageRequest):
    """
    Person 2's Gemini script gets plugged in here.
    """
    return {
        "status": "success",
        "fault": "Faulty Igniter", 
        "next_action": "Remove the lower front panel to access the burner compartment.",
        "audio_url": "https://api.elevenlabs.io/.../mock_audio.mp3"
    }

# 4. Step 2: The Visual Compositing Fallback (Unchanged)
@app.post("/api/visual-assist")
async def visual_assist(image: UploadFile = File(...)):
    """
    Person 3's Cloudinary overlay script gets plugged in here.
    """
    return {
        "status": "success",
        "composite_url": "https://res.cloudinary.com/.../mock_overlay.jpg" 
    }

# 5. --- NEW: THE HANDS-FREE REPAIR GUIDE ROUTE ---
@app.post("/api/repair-guide")
async def get_repair_guide(request: DiagnosisRequest):
    """
    This replaces the fake data. The frontend hits this endpoint once the 
    fault is diagnosed, and receives the JSON steps + local MP3 URLs.
    """
    # Hardcoded for the demo, but can be dynamic based on request.equipment
    pdf_path = "manuals/59SC6A-01SI REV D.pdf - 59SC6A-01SI.pdf" 
    
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="Manual not found on server.")

    try:
        # Step A: The Brain (Reads the PDF, outputs JSON)
        guide_data = generate_ikea_steps(
            {"equipment": request.equipment, "fault": request.fault},
            pdf_path
        )
        if "error" in guide_data:
            raise HTTPException(status_code=500, detail=guide_data["error"])

        raw_steps = guide_data.get("repair_steps", [])

        # Step B: The Voice (Generates MP3s from JSON)
        # Returns a map like: {1: "assets/audio/steps/step_1.mp3"}
        audio_paths = generate_step_audio(raw_steps)

        # Step C: Package it together
        for step in raw_steps:
            step_number = step["step"]
            # Convert the local path into a web URL the frontend can hit
            if step_number in audio_paths:
                # Add a leading slash so it resolves as http://localhost:8000/assets/...
                step["audio_url"] = f"/{audio_paths[step_number]}"
            else:
                step["audio_url"] = None
            
            # Placeholder for the IKEA images we discussed earlier
            step["image_url"] = f"/assets/images/{step.get('category', 'generic')}.png"

        guide_data["repair_steps"] = raw_steps

        return {
            "status": "success",
            "data": guide_data
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)