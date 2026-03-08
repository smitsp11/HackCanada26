import os
import time
import requests 
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("ELEVENLABS_API_KEY")
if not api_key:
    raise ValueError("FATAL: ELEVENLABS_API_KEY is missing from .env")

def generate_step_audio(steps_data: list, output_dir: str = "assets/audio/steps"):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    audio_map = {}
    url = "https://api.elevenlabs.io/v1/text-to-speech/nPczCjzI2devNBz1zQrb/stream"
    
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": api_key
    }

    for item in steps_data:
        step_num = item.get("step")
        action = item.get("action")
        caution = item.get("caution")
        
        script = f"Step {step_num}. {action}. "
        if caution and caution.lower() != "none":
            script += f"Caution: {caution}"

        print(f"\n--- Processing Step {step_num} ---")

        data = {
            "text": script,
            "model_id": "eleven_multilingual_v2",
            "output_format": "mp3_44100_128",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.5
            }
        }

        try:
            print(f"[DEBUG] Sending request to ElevenLabs...")
            
            # INCREASED TIMEOUTS: 10s to connect, 30s to download the audio
            response = requests.post(url, json=data, headers=headers, timeout=(10.0, 30.0))
            
            print(f"[DEBUG] HTTP Status Code Received: {response.status_code}")
            
            if response.status_code != 200:
                print(f"\n[FATAL API ERROR] ElevenLabs rejected the request:\n{response.text}\n")
                print("ABORTING REMAINING STEPS.")
                break 

            file_name = f"step_{step_num}.mp3"
            file_path = os.path.join(output_dir, file_name)
            
            with open(file_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024):
                    if chunk:
                        f.write(chunk)
            
            print(f"[SUCCESS] Saved to {file_path}")
            audio_map[step_num] = f"/{file_path}" 
            
            # THE HUMAN PACING
            # Wait 12 seconds so ElevenLabs thinks a user is reading the step
            if step_num != len(steps_data): # Don't sleep after the very last step
                print("[DEBUG] Sleeping for 12 seconds to mimic human reading pace...")
                time.sleep(12)
            
        except requests.exceptions.ReadTimeout:
            print(f"[NETWORK ERROR] Read Timeout. ElevenLabs took longer than 30 seconds to generate the file.")
        except Exception as e:
            print(f"[ERROR] Step {step_num} failed: {e}")

    return audio_map

if __name__ == "__main__":
    mock_steps = [
        {"step": 1, "action": "Turn off power.", "caution": "High voltage."},
        {"step": 2, "action": "Remove the panel.", "caution": "None"}
    ]
    generate_step_audio(mock_steps)