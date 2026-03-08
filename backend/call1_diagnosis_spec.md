## Call 1 — Diagnosis (MVP Spec)

This document specifies the MVP behaviour for **Call 1 — Diagnosis** for HVAC equipment, aligned with what current vision models can reliably do.

The goal: given **equipment visuals** (image or video) and a **transcribed technician description**, return a **single JSON object** describing the likely fault and one probing question.

---

### 1. Inputs and capabilities

- **Media input (required)**:
  - Source: one of:
    - A single **image** (photo of the equipment, nameplate, control board, etc.).
    - A short **video** recorded by the technician, which includes:
      - Visuals of the equipment (startup sequence, LED codes, flames, etc.).
      - Any **equipment sounds** captured in the video (clicks, hums, squeals, etc.).
  - Backend behaviour:
    - The backend uploads the file to Cloudinary via `process_media(file_path)`.
    - For **images**: we use the optimized Cloudinary URL directly.
    - For **videos**: we **do not** stream raw video into the model.
      - Instead, we sample a small set of keyframes (e.g. at 0s, 3s, 6s, 9s, 12s) and send those as images to the model.
      - Audio is only used indirectly via the **technician description** (see below) and whatever the model can infer as \"sounds\" from the scenario; we are not doing dedicated audio analysis in the MVP.

- **Technician description (required)**:
  - Format: **plain text string** that is the **transcribed technician description** (any speech-to-text happens upstream).
  - Examples:
    - \"On startup the inducer runs, I hear a click, but the burners never light.\"
    - \"Outdoor unit fan is spinning but no heat inside, heard a buzzing noise near the contactor.\"
  - The model should treat this description as **ground truth for sounds and symptoms** when there is any ambiguity in the visuals.

- **No separate raw audio input**:
  - Aside from what is in the video file itself and what the technician describes in text, **no separate audio stream** is provided.
  - The model should **not hallucinate** sounds that are not mentioned by the tech or clearly implied by standard failure patterns.

- **Unified endpoint behaviour**:
  - The Call 1 endpoint accepts a **single media file** (image or video) plus the **transcribed technician description**.
  - Internally, the \"video path\" includes both:
    - Direct image inputs.
    - Extracted keyframe images from videos.

---

### 2. JSON schema and field rules

The model must return **exactly one JSON object** with this shape:

```json
{
  "equipment_type": "furnace",
  "model_number": "59SC5A",
  "manufacturer": "Carrier",
  "sounds_detected": "clicking every 3 seconds on startup",
  "likely_fault": "faulty flame sensor",
  "confidence": "high",
  "probing_question": "Does the furnace attempt to ignite and then shut off after a few seconds?"
}
```

#### 2.1 Field semantics

- `equipment_type`:
  - Short string describing the **class of equipment**.
  - MVP controlled list (case-insensitive in outputs, but normalized to lower case in code):
    - `furnace`
    - `air_handler`
    - `boiler`
    - `heat_pump`
    - `rooftop_unit`
    - `mini_split`
    - `unknown`
  - If the type cannot be reliably determined from visuals + description, use `"unknown"`.

- `model_number`:
  - Best-effort extraction of the **exact model number** from a nameplate, sticker, or other visible markings.
  - If not visible, obscured, or unreadable, set to `"unknown"`.

- `manufacturer`:
  - Best-effort extraction of the **brand/manufacturer** (e.g., `"Carrier"`, `"Lennox"`, `"Trane"`).
  - If not visible or uncertain, set to `"unknown"`.

- `sounds_detected`:
  - Short free-text summary of **sounds described by the technician** that are relevant to the fault.
  - When possible, use the technician's wording, lightly normalized (e.g., `"clicking every 3 seconds on startup"`).
  - If the tech did **not** mention any sounds, or they are irrelevant, set to `"unknown"`.

- `likely_fault`:
  - A brief, technician-style label for the **single most likely fault** given the evidence.
  - Examples:
    - `"faulty flame sensor"`
    - `"blocked intake vent"`
    - `"failed inducer motor"`
    - `"low refrigerant charge"`
  - Avoid overly generic statements like `"something is wrong"`; if nothing reasonable can be inferred, use `"unknown"`.

- `confidence`:
  - Discrete confidence bucket for the **overall fault hypothesis**.
  - Allowed values (normalized to lower case):
    - `"low"` — weak or ambiguous evidence, multiple very different faults are plausible.
    - `"medium"` — reasonable hypothesis with some uncertainty (typical in real field work).
    - `"high"` — strong visual cues and description that point to one clear fault.
  - If the model attempts any other value, the backend will normalize it to `"low"`.

- `probing_question`:
  - A **single, concrete yes/no-style question** that a technician can answer on site to confirm or disprove the hypothesis.
  - Aim for short, practical questions:
    - `"Does the furnace attempt to ignite and then shut off after a few seconds?"`
    - `"Is the inducer motor running continuously without the burners lighting?"`
  - Must not be empty; if the model fails to produce a question, the backend will fall back to `"unknown"` but this is considered a model failure for MVP testing.

#### 2.2 Unknown and validation rules

- **Never** return `null`, empty strings, or omit fields.
- For any field that cannot be reasonably determined, set the value to `"unknown"`.
- Backend will:
  - Ensure all keys exist.
  - Normalize `equipment_type` and `confidence` to lowercase and allowed values.
  - Replace missing/empty/non-string values with `"unknown"`.
- **UI / frontend guidance**:
  - If any of `equipment_type`, `model_number`, or `manufacturer` are `"unknown"`, the UI should prompt the user to manually fill them in when possible (MVP behaviour note; does not change the API schema).

---

### 3. Prompt and modelling strategy

#### 3.1 System prompt (conceptual)

At a high level, the system prompt should:

- Emphasize that the assistant is a **senior HVAC technician** doing remote diagnosis.
- Instruct it to use **both**:
  - The transcribed technician description (primary source for sounds and symptoms).
  - The provided image frames from the equipment (primary source for visual clues, labels, and nameplates).
- Require:
  - A **single JSON object** with the exact keys described above.
  - Use of `"unknown"` when a value cannot be determined.
  - Realistic, non-overconfident language consistent with field practice.
  - Exactly **one** probing yes/no question.

The concrete implementation will:

- Convert the media into:
  - One or more `image_url` parts (optimized image or video keyframes).
  - A text part containing the technician description plus concise instructions.
- Use a **vision-capable JSON-mode LLM** (e.g., OpenAI GPT-4o family) with `response_format = { "type": "json_object" }`.
- Parse the JSON, then run it through a **normalization function** that:
  - Fills in missing keys with `"unknown"`.
  - Normalizes `equipment_type` and `confidence` to allowed values.
  - Ensures all values are strings.

#### 3.2 Error handling (MVP)

- If the LLM response is not valid JSON:
  - The CLI tool will treat it as an error and exit non-zero (developer-visible).
  - A production service built on top of this can either retry or return a 5xx with an internal error message.
- If JSON is valid but fields are missing/invalid:
  - The normalization layer will repair it into a valid object using the rules above.

---

### 4. MVP success criteria and example scenarios

#### 4.1 Success criteria

For a small labeled set of furnace-focused scenarios (images + descriptions), Call 1 is considered successful when:

- For the majority of cases:
  - `equipment_type` is correctly identified as `"furnace"` (or a correct alternative type).
  - `model_number` and `manufacturer` are correctly populated **when clearly visible**.
  - `likely_fault` is a plausible, specific failure mode that would make sense to an experienced technician.
- For **all** cases:
  - `probing_question` is non-empty, relevant, and practically answerable on site.
  - Fields that cannot be determined are set to `"unknown"` rather than hallucinated.

#### 4.2 Example scenarios (acceptance tests)

These are **illustrative** expected outputs to guide prompt tuning and manual testing. They are not hard-coded labels.

##### Scenario 1 — Classic flame sensor issue

- Media: video of a 90% gas furnace startup.
  - Inducer starts, a click is heard, burners light briefly, then shut off.
  - After several attempts, control board LED flashes an ignition-failure code.
- Technician description:
  - \"On startup the inducer comes on, I hear a click and see the burners light for a few seconds, then they shut off and it retries a couple times before locking out.\"

Expected JSON (approximate):

```json
{
  "equipment_type": "furnace",
  "model_number": "unknown",
  "manufacturer": "Carrier",
  "sounds_detected": "clicking on ignition and burner shutting off after a few seconds",
  "likely_fault": "faulty or dirty flame sensor",
  "confidence": "high",
  "probing_question": "When the burners shut off, does the control board show an ignition failure or flame loss error code?"
}
```

##### Scenario 2 — Inducer will not start

- Media: video of furnace with call for heat.
  - Thermostat calls for heat, nothing moves initially; control board shows a pressure switch/inducer error.
- Technician description:
  - \"Thermostat is calling for heat but the inducer never starts. I just hear a faint hum near the control board.\"

Expected JSON (approximate):

```json
{
  "equipment_type": "furnace",
  "model_number": "unknown",
  "manufacturer": "unknown",
  "sounds_detected": "faint hum near the control board, no inducer startup",
  "likely_fault": "failed inducer motor or seized inducer assembly",
  "confidence": "medium",
  "probing_question": "If you try to start the furnace, can you spin the inducer fan freely by hand with power off?"
}
```

##### Scenario 3 — Blocked intake/exhaust

- Media: video showing PVC vent piping partially blocked by snow/ice and control board code for pressure switch.
- Technician description:
  - \"Furnace tries to start, the inducer comes on and then shuts off. I found snow packed around the exhaust and intake terminations outside.\"

Expected JSON (approximate):

```json
{
  "equipment_type": "furnace",
  "model_number": "unknown",
  "manufacturer": "unknown",
  "sounds_detected": "inducer starts then stops shortly after",
  "likely_fault": "blocked intake or exhaust vent affecting pressure switch",
  "confidence": "high",
  "probing_question": "After you clear the snow or obstruction from the vent terminations, does the furnace complete a full heat cycle without shutting off?"
}
```

##### Scenario 4 — Nameplate unreadable (unknown manufacturer/model)

- Media: slightly blurry image of furnace cabinet; brand and model are not legible.
- Technician description:
  - \"Older gas furnace, burners light and stay on, but there is visible flame rollout around the burner compartment.\"

Expected JSON (approximate):

```json
{
  "equipment_type": "furnace",
  "model_number": "unknown",
  "manufacturer": "unknown",
  "sounds_detected": "unknown",
  "likely_fault": "flame rollout likely due to blocked heat exchanger or venting issue",
  "confidence": "medium",
  "probing_question": "With power off, can you see any obvious obstructions or heavy soot buildup in the burner and heat exchanger area?"
}
```

These scenarios should be used to:

- Manually test the Call 1 pipeline end-to-end during MVP.
- Tune the prompt so outputs stay within the schema and give realistic, technician-grade hypotheses and questions.

