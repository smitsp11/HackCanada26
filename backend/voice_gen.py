import os
import time
import requests 
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("ELEVENLABS_API_KEY")

def generate_step_audio(steps_data: list, output_dir: str = "assets/audio/steps"):
    """
    Generates MP3 files for each repair step using ElevenLabs Flash v2.5.
    Returns a mapping of step numbers to their local URL paths.
    """
    # Ensure absolute pathing relative to the backend folder
    base_dir = os.path.dirname(os.path.abspath(__file__))
    full_output_dir = os.path.join(base_dir, output_dir)
    
    if not os.path.exists(full_output_dir):
        os.makedirs(full_output_dir, exist_ok=True)

    audio_map = {}
    url = "https://api.elevenlabs.io/v1/text-to-speech/nPczCjzI2devNBz1zQrb"
    
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": api_key
    }

    for item in steps_data:
        step_num = item.get("step")
        action = item.get("action")
        caution = item.get("caution")
        
        # Construct the script Brian will read
        script = f"Step {step_num}. {action}. "
        if caution and caution.lower() != "none":
            script += f"Caution: {caution}"

        data = {
            "text": script,
            "model_id": "eleven_flash_v2_5", 
            "voice_settings": { "stability": 0.5, "similarity_boost": 0.5 }
        }

        try:
            # Using standard POST (not streaming) for higher network reliability
            response = requests.post(url, json=data, headers=headers, timeout=60)
            
            if response.status_code == 200:
                file_name = f"step_{step_num}.mp3"
                file_path = os.path.join(full_output_dir, file_name)
                
                with open(file_path, "wb") as f:
                    f.write(response.content)
                
                # Path relative to the FastAPI 'assets' mount
                audio_map[step_num] = f"/assets/audio/steps/{file_name}"
            
            # Rate limiting / Human pacing delay
            if step_num != len(steps_data):
                time.sleep(12)
            
        except Exception as e:
            print(f"Failed to generate audio for step {step_num}: {e}")

    return audio_map