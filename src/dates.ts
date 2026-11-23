// Dates are kept as said (date_text) and in the Library of Congress Extended
// Date/Time Format (date_edtf): 1965, 1965-07, 1965~ (about), 1965? (maybe),
// 196X (the 1960s), 1965-22 (summer).

/** EDTF -> XMP date (YYYY, YYYY-MM, YYYY-MM-DD). Decades and seasons give the year or nothing. */
export function edtfToXmpDate(edtf: string | null | undefined): string | null {
  if (!edtf) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(edtf);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (!mo || Number(mo) > 12) return y;
  return d ? `${y}-${mo}-${d}` : `${y}-${mo}`;
}

/** Does an EDTF date fall (at least partly) within the given years? */
export function edtfInRange(edtf: string | null | undefined, from: string, to: string): boolean {
  const m = /^(\d{2})(\d|X)(\d|X)/.exec(edtf ?? "");
  if (!m) return false;
  const lo = Number(`${m[1]}${m[2] === "X" ? "0" : m[2]}${m[3] === "X" ? "0" : m[3]}`);
  const hi = Number(`${m[1]}${m[2] === "X" ? "9" : m[2]}${m[3] === "X" ? "9" : m[3]}`);
  return hi >= Number(from) && lo <= Number(to);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SEASONS: Record<string, string> = { spring: "21", summer: "22", autumn: "23", fall: "23", winter: "24" };

/**
 * Turn a date as typed or said into EDTF, when it is clear enough:
 * "1965" -> 1965, "about 1965" -> 1965~, "maybe 1965" -> 1965?, "the 1960s" -> 196X,
 * "July 1965" -> 1965-07, "summer 1965" -> 1965-22, "1965-07-04" -> 1965-07-04.
 * Returns null when no year can be found.
 */
export function toEdtf(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (/^\d{4}(-\d{2}(-\d{2})?)?[~?%]?$/.test(t)) return t;
  const about = /\b(about|around|circa|ca\.?|approximately|roughly)\b|~/.test(t);
  const maybe = /\b(maybe|perhaps|possibly|probably|i think)\b|\?/.test(t);
  const qual = about && maybe ? "%" : about ? "~" : maybe ? "?" : "";
  const decade = /\b(\d{3})0'?s\b/.exec(t);
  if (decade) return `${decade[1]}X`;
  const year = /\b(1[6-9]\d{2}|20\d{2})\b/.exec(t);
  if (!year) return null;
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(t));
  if (month >= 0) {
    const day = new RegExp(`\\b${MONTHS[month].slice(0, 3)}[a-z]*\\.? (\\d{1,2})(st|nd|rd|th)?\\b`).exec(t);
    return `${year[1]}-${String(month + 1).padStart(2, "0")}${day ? `-${day[1].padStart(2, "0")}` : ""}${qual}`;
  }
  const season = Object.keys(SEASONS).find((s) => t.includes(s));
  if (season) return `${year[1]}-${SEASONS[season]}${qual}`;
  return `${year[1]}${qual}`;
}
