# OPERA flow — context for production

Reference for the end-to-end pipeline. Use this when implementing or reasoning about the system.

---

## 1. Media Intake

User uploads either a video or image of their broken appliance.

- **Video:** Cloudinary slices it into 3 targeted frames (brand, model, overall condition) and extracts the audio as MP3.
- **Image:** Passes straight through.

This is the raw evidence collection.

---

## 2. Media Enhancement

Cloudinary runs quality normalization:

- Fixes bad lighting
- Reduces noise/grain
- Sharpens edges

This isn’t cosmetic. A blurry model number plate becomes readable. A dark laundry room shot becomes analyzable. The accuracy of everything downstream depends on this step working well.

---

## 3. Device Identification

Gemini receives the enhanced frames and does visual + contextual reasoning to determine the **exact** make and model.

- Not just “Samsung washing machine” — ideally **SAMSUNG WF45R6100AW**.
- The more precise the identification, the more precise the repair guidance.

This is the first moment the system knows what it’s dealing with.

---

## 4. Manual Retrieval

Using the identified make and model, the system queries your database for the **official service or user manual** for that specific device.

This is your moat starting to activate — you’ve pre-indexed manuals so the system isn’t guessing; it’s reading the actual authoritative document for that exact appliance.

---

## 5. Reference Triangulation

Gemini cross-references three things simultaneously:

1. The user’s original problem description  
2. Any audio anomalies extracted from the video  
3. The relevant sections of the retrieved manual  

It also surfaces specific **YouTube repair videos** matched to the fault.

This is where the symptom gets a **diagnosis** rather than a guess.

---

## 6. Instruction Synthesis

Gemini takes everything — device identity, manual sections, symptom analysis, audio data, video references — and distills it into **plain language repair steps**.

- 1–2 sentences each  
- Ordered logically  
- Written for a non-technical homeowner  
- No jargon, no assumptions about tools they don’t have  

---

## 7. Visual Schematic Generation

This is the moat.

Each plain language step gets paired with an **Ikea-style illustrated visual** — a clear, wordless diagram showing exactly what to do physically:

- Tighten this bolt  
- Press this panel  
- Locate this component  

The combination of **plain text + visual schematic** is what separates OPERA from every other repair guide on the internet. A user who has never opened an appliance before can follow it.
