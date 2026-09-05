import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sanitizeConsultation, sanitizeWaiver, WAIVER_VERSION } from '../lib/forms.js';
import { WAIVER_TITLE, WAIVER_INTRO, WAIVER_SECTIONS } from '../lib/waiverText.js';
import { sendOwnerFormAlert, sendWaiverCopy } from '../lib/email.js';

const router = Router();

// Public site origin, for the "open in Admin" link in owner alerts.
const SITE_URL = (process.env.FRONTEND_URL || 'https://bladeandash.com').split(',')[0].trim();

// Columns the admin list needs. The signature image is heavy and only wanted
// on the detail view, so it stays out of the list select.
const LIST_COLUMNS = 'id, kind, client_id, client_name, client_email, client_phone, agreement_version, created_at';

function clampPagination(limit, offset, { maxLimit = 200 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxLimit);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  return { lim, off };
}

// ──────────────────────────────────────────────
// Public
// ──────────────────────────────────────────────

// GET /waiver-text — the agreement the signing page renders. Served from the
// API so the page, the stored version, and the emailed copy can't drift.
router.get('/waiver-text', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ version: WAIVER_VERSION, title: WAIVER_TITLE, intro: WAIVER_INTRO, sections: WAIVER_SECTIONS });
});

async function store(req, kind, value) {
  const row = {
    kind,
    client_id: req.user?.id || null,
    client_name: value.client_name,
    client_email: value.client_email || null,
    client_phone: value.client_phone || null,
    data: value.data,
    signature_data_url: value.signature_data_url || null,
    agreement_version: value.agreement_version || null,
    ip: req.ip || null,
    user_agent: String(req.get('user-agent') || '').slice(0, 300) || null,
  };

  const { data, error } = await supabase
    .from('client_forms')
    .insert(row)
    .select(LIST_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// Owner heads-up is best-effort: a lost email must never fail the submission
// that's already stored.
async function notifyOwner(kind, saved) {
  try {
    await sendOwnerFormAlert({
      kind,
      clientName: saved.client_name,
      clientEmail: saved.client_email,
      clientPhone: saved.client_phone,
      submittedAt: saved.created_at,
      adminUrl: `${SITE_URL}/admin?tab=forms&form=${saved.id}`,
    });
  } catch (e) {
    console.error('Owner form alert failed:', e.message);
  }
}

// POST /waiver — sign the Client Service Agreement. Works signed-in or as a
// guest; when signed in the row is linked to the account.
router.post('/waiver', optionalAuth, async (req, res) => {
  const result = sanitizeWaiver(req.body, req.user?.profile || null);
  if (!result.ok) return res.status(400).json({ error: result.error });

  let saved;
  try {
    saved = await store(req, 'waiver', result.value);
  } catch (e) {
    console.error('Waiver insert failed:', e.message);
    return res.status(500).json({ error: 'Could not save your signature. Please try again.' });
  }

  // The client's copy. Best-effort too, but the response says whether it went
  // out so the page can tell them to expect it (or not).
  let emailed = false;
  try {
    await sendWaiverCopy({
      to: saved.client_email,
      clientName: saved.client_name,
      guardianName: result.value.data.guardian_name || null,
      signedAt: saved.created_at,
      version: saved.agreement_version,
      signatureDataUrl: result.value.signature_data_url,
      title: WAIVER_TITLE,
      intro: WAIVER_INTRO,
      sections: WAIVER_SECTIONS,
    });
    emailed = true;
  } catch (e) {
    console.error('Waiver copy email failed:', e.message);
  }

  notifyOwner('waiver', saved);

  return res.status(201).json({ form: saved, emailed });
});

// POST /consultation — the pre-visit hair questionnaire.
router.post('/consultation', optionalAuth, async (req, res) => {
  const result = sanitizeConsultation(req.body, req.user?.profile || null);
  if (!result.ok) return res.status(400).json({ error: result.error });

  let saved;
  try {
    saved = await store(req, 'consultation', result.value);
  } catch (e) {
    console.error('Consultation insert failed:', e.message);
    return res.status(500).json({ error: 'Could not save your answers. Please try again.' });
  }

  notifyOwner('consultation', saved);

  return res.status(201).json({ form: saved });
});

// ──────────────────────────────────────────────
// Signed-in client
// ──────────────────────────────────────────────

// GET /mine — what the signed-in client has on file (dates only, no bodies),
// so their profile can show "Waiver signed Sep 4" and nudge for the rest.
router.get('/mine', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('client_forms')
    .select('id, kind, agreement_version, created_at')
    .eq('client_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Newest of each kind.
  const latest = {};
  for (const row of data || []) {
    if (!latest[row.kind]) latest[row.kind] = row;
  }
  return res.json({ forms: latest, current_waiver_version: WAIVER_VERSION });
});

// ──────────────────────────────────────────────
// Admin
// ──────────────────────────────────────────────

// GET / — list submissions, newest first. ?kind=waiver|consultation,
// ?search= (name/email/phone), ?client_id=, ?limit=, ?offset=.
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { kind, search, client_id, limit, offset } = req.query;
  const { lim, off } = clampPagination(limit, offset);

  let query = supabase
    .from('client_forms')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(off, off + lim - 1);

  if (kind === 'waiver' || kind === 'consultation') query = query.eq('kind', kind);
  if (client_id) query = query.eq('client_id', String(client_id));

  if (search) {
    // PostgREST .or() parses commas/parens as syntax — strip them (plus
    // wildcards) so a search term can't alter the filter.
    const safe = String(search).replace(/[,()%_]/g, ' ').trim().slice(0, 100);
    if (safe) {
      query = query.or(`client_name.ilike.%${safe}%,client_email.ilike.%${safe}%,client_phone.ilike.%${safe}%`);
    }
  }

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ forms: data, total: count });
});

// GET /:id — one submission in full (answers + signature).
router.get('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('client_forms')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error && error.code === 'PGRST116') return res.status(404).json({ error: 'Form not found' });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ form: data });
});

// DELETE /:id — remove a submission (e.g. a duplicate or a test entry).
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('client_forms').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

export default router;
