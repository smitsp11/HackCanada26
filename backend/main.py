import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles 
from pydantic import BaseModel

# Import your custom modules
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

# Serve the audio files to the frontend
os.makedirs("assets", exist_ok=True)
app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# 2. Data Schemas
class TriageRequest(BaseModel):
    media_url: str
    equipment_model: str

class DiagnosisRequest(BaseModel):
    equipment: str
    fault: str

# 3. Step 1: The Initial Audio/Video Diagnostic
@app.post("/api/triage")
async def initial_triage(request: TriageRequest):
    return {
        "status": "success",
        "fault": "Faulty Igniter", 
        "next_action": "Remove the lower front panel to access the burner compartment.",
        "audio_url": "https://api.elevenlabs.io/.../mock_audio.mp3"
    }

# 4. Step 2: The Visual Compositing Fallback
@app.post("/api/visual-assist")
async def visual_assist(image: UploadFile = File(...)):
    return {
        "status": "success",
        "composite_url": "https://res.cloudinary.com/.../mock_overlay.jpg" 
    }

# 5. THE HANDS-FREE REPAIR GUIDE ROUTE
@app.post("/api/repair-guide")
async def get_repair_guide(request: DiagnosisRequest):
    pdf_path = "manuals/59SC6A-01SI REV D.pdf - 59SC6A-01SI.pdf" 
    
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="Manual not found on server.")

    try:
        # Step A: The Brain (Reads the PDF, outputs JSON)
        print("\n--- [1/2] Generating RAG Steps ---")
        guide_data = generate_ikea_steps(
            {"equipment": request.equipment, "fault": request.fault},
            pdf_path
        )
        if "error" in guide_data:
            raise HTTPException(status_code=500, detail=guide_data["error"])

        raw_steps = guide_data.get("repair_steps", [])

        # Step B: The Voice (Generates MP3s sequentially with a throttle)
        print(f"\n--- [2/2] Generating ElevenLabs Audio ({len(raw_steps)} steps) ---")
        audio_paths = generate_step_audio(raw_steps)

        # Step C: Package it together
        for step in raw_steps:
            step_number = step["step"]
            if step_number in audio_paths:
                # The voice_gen already adds a leading slash (e.g. "/assets/audio/...")
                step["audio_url"] = audio_paths[step_number]
            else:
                step["audio_url"] = None
            
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