import os
import httpx 
from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("ELEVENLABS_API_KEY")
if not api_key:
    raise ValueError("FATAL: ELEVENLABS_API_KEY is missing from .env")

# 1. Initialize with a 15-second timeout for hackathon network safety
client = ElevenLabs(
    api_key=api_key,
    httpx_client=httpx.Client(timeout=15.0) 
)

def generate_step_audio(steps_data: list, output_dir: str = "assets/audio/steps"):
    """
    Generates an MP3 for each repair step.
    FRONTEND LINK: The API will return the local paths to these MP3s. 
    The frontend should pre-load them and use the Web Speech API to listen 
    for the word "Next" to trigger the next file in the sequence.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    audio_map = {}

    for item in steps_data:
        step_num = item.get("step")
        action = item.get("action")
        caution = item.get("caution")
        
        script = f"Step {step_num}. {action}. "
        if caution and caution.lower() != "none":
            script += f"Caution: {caution}"

        print(f"Generating audio for Step {step_num}...")

        try:
            audio_stream = client.text_to_speech.convert(
                text=script,
                voice_id="nPczCjzI2devNBz1zQrb", # Brian
                model_id="eleven_multilingual_v2",
                output_format="mp3_44100_128"
            )
            
            file_name = f"step_{step_num}.mp3"
            file_path = os.path.join(output_dir, file_name)
            
            with open(file_path, "wb") as f:
                for chunk in audio_stream:
                    if chunk:
                        f.write(chunk)
            
            audio_map[step_num] = f"/{file_path}" 
            
        except httpx.TimeoutException:
            print(f"[ERROR] Step {step_num} failed: Network timeout.")
        except Exception as e:
            print(f"[ERROR] Step {step_num} failed: {e}")

    return audio_map

if __name__ == "__main__":
    # --- FRONTEND / INTEGRATION COMMENTS ---
    # REPLACE THIS MOCK DATA when integrating. 
    # In production, `mock_steps` will be replaced by the output of `generate_ikea_steps()` 
    # from your instr_gen.py file. See main.py for the actual implementation.
    mock_steps = [
        {"step": 1, "action": "Turn off power.", "caution": "High voltage."}
    ]
    generate_step_audio(mock_steps)