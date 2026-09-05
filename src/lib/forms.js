// Validation for the two client-facing forms: the signed waiver and the
// consultation intake. Pure functions (no I/O) so they're unit-testable and
// so the route stays a thin wrapper.
//
// Both return { ok: true, value } or { ok: false, error } — never throw.

// Bump when the agreement text on the website changes, so a stored row
// records exactly which wording the client signed.
export const WAIVER_VERSION = '2026-09-04';

const MAX_TEXT = 2000;
const MAX_SHORT = 200;
// A drawn signature is a small PNG; 200 KB is generous headroom for a
// high-DPI canvas without letting someone park a photo in the column.
const MAX_SIGNATURE_BYTES = 200 * 1024;

function str(v, max = MAX_SHORT) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function text(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT);
}

function yesNo(v) {
  if (v === true || v === 'yes') return 'yes';
  if (v === false || v === 'no') return 'no';
  return '';
}

function oneOf(v, options) {
  return options.includes(v) ? v : '';
}

function manyOf(v, options) {
  if (!Array.isArray(v)) return [];
  return options.filter((o) => v.includes(o));
}

// '' when blank, the lowercased address when it looks like one, null when
// something was typed that can't be an address.
function email(v) {
  const e = str(v).toLowerCase();
  if (!e) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Contact block shared by both forms. When `profile` is present (signed-in
// submitter) the name/phone fall back to the account so a returning client
// doesn't have to retype them, but anything they typed wins.
function contact(body, profile) {
  const name = str(body.client_name) || str(profile?.full_name);
  const mail = email(body.client_email);
  if (mail === null) return { error: 'Please enter a valid email address.' };
  return {
    client_name: name,
    client_email: mail || '',
    client_phone: str(body.client_phone, 40) || str(profile?.phone, 40),
  };
}

export const CONSULTATION_OPTIONS = {
  services: ['Haircut', 'Color', 'Perm', 'Extensions'],
  length: ['Above shoulder', 'Below shoulder', 'Mid back', 'At waist', 'Below waist'],
  conditions: ['Pregnant', 'Postpartum', 'Menopause', 'None'],
  feel: ['Dry', 'Oily', 'Brittle', 'Healthy'],
  hairtype: ['Fine / straight', 'Curly', 'Coarse'],
  density: ['Thin', 'Thick', 'In between', 'Unsure'],
};

export function sanitizeConsultation(body = {}, profile = null) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid form.' };
  const c = contact(body, profile);
  if (c.error) return { ok: false, error: c.error };
  if (!c.client_name) return { ok: false, error: 'Please enter your name.' };

  const a = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const O = CONSULTATION_OPTIONS;

  const data = {
    services: manyOf(a.services, O.services),
    length: oneOf(a.length, O.length),
    cut_frequency: str(a.cut_frequency),
    chemical_frequency: str(a.chemical_frequency),

    color_before: yesNo(a.color_before),
    last_color_date: str(a.last_color_date),

    perm_before: yesNo(a.perm_before),
    last_perm_date: str(a.last_perm_date),

    ext_before: yesNo(a.ext_before),
    ext_type: str(a.ext_type),
    ext_feedback: text(a.ext_feedback),

    meds: yesNo(a.meds),
    meds_list: str(a.meds_list, 500),
    conditions: manyOf(a.conditions, O.conditions),

    allergies: yesNo(a.allergies),
    allergies_list: str(a.allergies_list, 500),

    wash_frequency: str(a.wash_frequency),
    colorblind: yesNo(a.colorblind),
    feel: manyOf(a.feel, O.feel),
    hairtype: oneOf(a.hairtype, O.hairtype),
    density: oneOf(a.density, O.density),

    goals: text(a.goals),
    likes_dislikes: text(a.likes_dislikes),
  };

  // Conditional answers only make sense after a "yes" — drop stragglers so
  // the record never says "no colour history" next to a colour date.
  if (data.color_before !== 'yes') data.last_color_date = '';
  if (data.perm_before !== 'yes') data.last_perm_date = '';
  if (data.ext_before !== 'yes') { data.ext_type = ''; data.ext_feedback = ''; }
  if (data.meds !== 'yes') data.meds_list = '';
  if (data.allergies !== 'yes') data.allergies_list = '';

  // "None" is exclusive.
  if (data.conditions.includes('None') && data.conditions.length > 1) {
    data.conditions = data.conditions.filter((x) => x !== 'None');
  }

  if (data.services.length === 0) return { ok: false, error: 'Please pick at least one service.' };

  return { ok: true, value: { ...c, data } };
}

function signature(v) {
  if (typeof v !== 'string') return null;
  const prefix = 'data:image/png;base64,';
  if (!v.startsWith(prefix)) return null;
  const b64 = v.slice(prefix.length);
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  // base64 inflates by 4/3; check the decoded size, not the string length.
  if ((b64.length * 3) / 4 > MAX_SIGNATURE_BYTES) return null;
  return v;
}

export function sanitizeWaiver(body = {}, profile = null) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid form.' };
  const c = contact(body, profile);
  if (c.error) return { ok: false, error: c.error };
  if (!c.client_name) return { ok: false, error: 'Please print your full name.' };
  if (!c.client_email) return { ok: false, error: 'Please enter your email so we can send you a copy.' };

  if (body.agreed !== true) {
    return { ok: false, error: 'Please confirm you have read and agree to the agreement.' };
  }

  const sig = signature(body.signature);
  if (!sig) return { ok: false, error: 'Please sign in the signature box.' };

  const isGuardian = body.is_guardian === true;
  const guardianName = isGuardian ? str(body.guardian_name) : '';
  if (isGuardian && !guardianName) {
    return { ok: false, error: 'Please print the parent or guardian name.' };
  }

  return {
    ok: true,
    value: {
      ...c,
      signature_data_url: sig,
      agreement_version: WAIVER_VERSION,
      data: {
        agreed: true,
        is_guardian: isGuardian,
        guardian_name: guardianName,
        // Typed name is stored separately from the account name so the
        // record shows exactly what they printed on the line.
        printed_name: c.client_name,
      },
    },
  };
}
