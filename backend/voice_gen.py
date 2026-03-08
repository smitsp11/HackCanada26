import os
import json
import time
import httpx  # <--- Adding this to force a network timeout
from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv

load_dotenv()

# --- DEBUG: Verify the key is actually loading ---
api_key = os.getenv("ELEVENLABS_API_KEY")
if api_key:
    print(f"[DEBUG] API Key Loaded: {api_key[:4]}...{api_key[-4:]}")
else:
    print("[DEBUG] FATAL: API KEY IS MISSING OR NONE!")

# 1. Initialize ElevenLabs WITH A TIMEOUT
# If ElevenLabs ignores us, this forces a crash after 15 seconds instead of hanging forever.
client = ElevenLabs(
    api_key=api_key,
    httpx_client=httpx.Client(timeout=15.0) 
)

def generate_step_audio(steps_data: list, output_dir: str = "assets/audio/steps"):
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

        print(f"\n--- Processing Step {step_num} ---")

        try:
            print("[DEBUG] 1. Sending API request to ElevenLabs... (Waiting for response)")
            start_time = time.time()
            
            # The network call
            audio_stream = client.text_to_speech.convert(
                text=script,
                voice_id="nPczCjzI2devNBz1zQrb", # Brian
                model_id="eleven_multilingual_v2",
                output_format="mp3_44100_128"
            )
            
            print(f"[DEBUG] 2. Response received in {time.time() - start_time:.2f} seconds!")
            
            file_name = f"step_{step_num}.mp3"
            file_path = os.path.join(output_dir, file_name)
            
            print(f"[DEBUG] 3. Opening local file: {file_path}")
            with open(file_path, "wb") as f:
                print("[DEBUG] 4. Writing chunks: ", end="", flush=True)
                chunk_count = 0
                for chunk in audio_stream:
                    if chunk:
                        f.write(chunk)
                        chunk_count += 1
                        print(".", end="", flush=True) # Print a dot for every chunk received
                print(f" (Total chunks: {chunk_count})")
            
            print(f"[DEBUG] 5. File successfully saved!")
            audio_map[step_num] = file_path
            
        except httpx.TimeoutException:
            print(f"\n[FATAL ERROR]: Network Timeout. ElevenLabs is completely ignoring the request (Tarpit).")
        except Exception as e:
            print(f"\n[FATAL ERROR]: {type(e).__name__} - {e}")

    return audio_map

if __name__ == "__main__":
    print("--- ELEVENLABS DEBUGGER START ---")
    
    mock_steps = [
        {
            "step": 1, 
            "action": "Ensure the furnace is completely powered down.", 
            "caution": "High voltage can be fatal."
        }
    ]
    
    generate_step_audio(mock_steps)