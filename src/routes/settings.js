import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sanitizeSettings } from '../lib/settings.js';

const router = Router();

// Business info lives as one JSON object in a private Storage bucket — same
// no-table, no-migration pattern as the gallery. The public GET below is the
// only read path (the bucket itself is not public).
const BUCKET = 'settings';
const OBJECT = 'salon-info.json';

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 64 * 1024,
    allowedMimeTypes: ['application/json'],
  });
  if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
  bucketReady = true;
}

async function readSettings() {
  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET).download(OBJECT);
  if (error) {
    if (/not.?found|does not exist|400/i.test(error.message)) return {};
    throw new Error(error.message);
  }
  try {
    return JSON.parse(await data.text());
  } catch {
    return {};
  }
}

// GET / — public business info (footer, SEO schema). {} until filled in.
router.get('/', async (req, res) => {
  try {
    const settings = await readSettings();
    // Cacheable briefly: this changes rarely but must not stick for days.
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// PUT / — replace business info (admin). Body is the full settings object;
// unknown keys and invalid values are silently dropped (lib/settings.js).
router.put('/', requireAuth, requireRole('admin'), async (req, res) => {
  const clean = sanitizeSettings(req.body);
  try {
    await ensureBucket();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(OBJECT, JSON.stringify(clean, null, 2), {
        contentType: 'application/json',
        upsert: true,
        cacheControl: '0',
      });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(clean);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
