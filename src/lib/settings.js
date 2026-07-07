// Salon business-info settings: validation/sanitization shared by the route
// and unit tests. Settings are stored as one JSON object (see routes/settings.js);
// every field is optional so the salon can fill things in over time.

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const URL_FIELDS = ['instagram', 'facebook', 'tiktok', 'maps_url'];
const TEXT_FIELDS = {
  business_name: 80,
  address_line: 120,
  city: 60,
  state: 30,
  zip: 12,
  phone: 25,
  public_email: 120,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // "HH:MM" 24h

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().slice(0, 300);
  if (!v) return '';
  // Require https so a typo'd or hostile value can't become javascript: etc.
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.href;
  } catch {
    return '';
  }
}

function cleanHours(hours) {
  const out = {};
  if (!hours || typeof hours !== 'object') return out;
  for (const day of DAYS) {
    const d = hours[day];
    if (!d || typeof d !== 'object') continue;
    if (d.closed === true) {
      out[day] = { closed: true };
      continue;
    }
    const open = typeof d.open === 'string' && TIME_RE.test(d.open) ? d.open : null;
    const close = typeof d.close === 'string' && TIME_RE.test(d.close) ? d.close : null;
    if (open && close) out[day] = { open, close, closed: false };
  }
  return out;
}

/** Sanitize a client-supplied settings object into the stored shape.
 *  Unknown keys are dropped; invalid values become empty/absent. */
export function sanitizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, maxLen] of Object.entries(TEXT_FIELDS)) {
    out[key] = cleanText(raw[key], maxLen);
  }
  for (const key of URL_FIELDS) {
    out[key] = cleanUrl(raw[key]);
  }
  out.hours = cleanHours(raw.hours);
  return out;
}

export { DAYS };
