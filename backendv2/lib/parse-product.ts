const KNOWN_BRANDS = [
  "Carrier", "Lennox", "Trane", "Rheem", "Goodman", "Bryant", "York",
  "Daikin", "Bosch", "Amana", "Whirlpool", "GE", "Samsung", "LG",
  "Frigidaire", "Maytag", "Kenmore", "KitchenAid", "Honeywell",
  "Mitsubishi", "Fujitsu", "Heil", "Ruud", "Coleman", "Payne",
  "American Standard", "Nortek", "Broan", "Navien", "Rinnai",
  "Tankless", "AO Smith", "Bradford White",
];

const BRAND_PATTERN = new RegExp(
  `\\b(${KNOWN_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

const MODEL_PATTERNS = [
  /(?:model\s*(?:no\.?|number|#)?|m\/n|mod(?:el)?\.?)\s*[:.]?\s*([A-Z0-9][\w\-./]{3,})/i,
  /(?:part\s*(?:no\.?|number|#)?|p\/n)\s*[:.]?\s*([A-Z0-9][\w\-./]{3,})/i,
  /(?:cat(?:alog)?\.?\s*(?:no\.?|number|#)?)\s*[:.]?\s*([A-Z0-9][\w\-./]{3,})/i,
  /(?:serial\s*(?:no\.?|number|#)?|s\/n)\s*[:.]?\s*([A-Z0-9][\w\-./]{3,})/i,
];

/**
 * Fallback: find any token that looks like an appliance model number.
 * Typical patterns: letter(s) + digits + optional suffixes (e.g. 59SC6A060M17--16).
 */
const GENERIC_MODEL_RE = /\b([A-Z]{1,4}\d{2,}[\w\-./]{2,})\b/i;

export function parseProduct(text: string): {
  company?: string;
  modelNumber?: string;
} {
  const brandMatch = text.match(BRAND_PATTERN);
  const company = brandMatch ? brandMatch[1] : undefined;

  let modelNumber: string | undefined;

  for (const pattern of MODEL_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      modelNumber = m[1].trim();
      break;
    }
  }

  if (!modelNumber) {
    const generic = text.match(GENERIC_MODEL_RE);
    if (generic) {
      modelNumber = generic[1].trim();
    }
  }

  return { company, modelNumber };
}
