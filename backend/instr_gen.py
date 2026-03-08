import json
import os
import time
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()


client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def generate_ikea_steps(diagnosis: dict, manual_path: str) -> dict:
    """
    Takes a diagnosis dict (from /api/triage) and a manual PDF path.
    Returns structured IKEA-style repair steps grounded in the manual.

    Expected diagnosis keys: equipment_type, likely_fault
    """
    if not os.path.exists(manual_path):
        return {"error": "Manual not found"}

    print(f"Uploading and processing: {os.path.basename(manual_path)}...")

    with open(manual_path, "rb") as f:
        file_ref = client.files.upload(
            file=f,
            config={"mime_type": "application/pdf"}
        )

    while file_ref.state and file_ref.state.name == "PROCESSING":
        print(".", end="", flush=True)
        time.sleep(2)
        if file_ref.name is None:
            raise ValueError("File name is None")
        file_ref = client.files.get(name=file_ref.name)

    if file_ref.state and file_ref.state.name == "FAILED":
        raise ValueError("PDF processing failed.")

    # Map triage keys to prompt
    equipment  = diagnosis.get("equipment_type", "unknown equipment")
    fault      = diagnosis.get("likely_fault", "unknown fault")

    prompt = f"""
    Using the PROVIDED MANUAL as your ONLY source:
    Equipment: {equipment} | Fault: {fault}

    
    Return a JSON object:
    {{
      "page": "string",
      "repair_steps": [
        {{
          "step": number,
          "category": "power|gas|tool|screw|wiring", 
          "action": "Short action text",
          "caution": "Crucial safety note or 'None'",
          "visual_description": "IKEA-style line drawing prompt"
        }}
      ]
    }}
    """

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[file_ref, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.0
        )
    )

    res_text = response.text
    return json.loads(res_text) if res_text else {}


if __name__ == "__main__":
    mock_triage = {"equipment_type": "Carrier Furnace", "likely_fault": "Igniter"}
    pdf_path    = "manuals/59SC6A-01SI REV D.pdf - 59SC6A-01SI.pdf"

    try:
        data = generate_ikea_steps(mock_triage, pdf_path)
        print("\n--- REPAIR GUIDE GENERATED ---")
        print(json.dumps(data, indent=2))
    except Exception as e:
        print(f"\nError: {e}")