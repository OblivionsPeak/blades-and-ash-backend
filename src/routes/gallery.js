import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { supabase } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

const router = Router();

// Photos live in a public Supabase Storage bucket — the bucket listing IS the
// gallery (no table, no migration). Admin uploads/deletes; the home page reads.
const BUCKET = 'gallery';
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Create the bucket on first use so deploys need no manual Supabase setup.
// Safe to race: "already exists" is success.
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: Object.keys(ALLOWED_TYPES),
  });
  if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
  bucketReady = true;
}

// GET / — public list of gallery photos, newest first.
router.get('/', async (req, res) => {
  try {
    await ensureBucket();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const { data, error } = await supabase.storage.from(BUCKET).list('', {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) return res.status(500).json({ error: error.message });

  const photos = (data || [])
    .filter((f) => f.name && !f.name.startsWith('.'))
    .map((f) => ({
      name: f.name,
      url: supabase.storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
      created_at: f.created_at,
    }));

  return res.json(photos);
});

// POST / — upload one photo (admin). The image is sent as the raw request
// body (the frontend resizes to JPEG client-side, so uploads stay small);
// express.json() ignores non-JSON content types, so raw parsing here is safe.
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  express.raw({ type: Object.keys(ALLOWED_TYPES), limit: '10mb' }),
  async (req, res) => {
    const contentType = (req.get('Content-Type') || '').split(';')[0].trim();
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
      return res.status(415).json({ error: 'Photos must be JPEG, PNG, or WebP images.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No image data received.' });
    }

    try {
      await ensureBucket();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Server-generated name: sortable timestamp + randomness, never client input.
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(name, req.body, { contentType, cacheControl: '31536000' });
    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({
      name,
      url: supabase.storage.from(BUCKET).getPublicUrl(name).data.publicUrl,
    });
  }
);

// DELETE /:name — remove a photo (admin).
router.delete('/:name', requireAuth, requireRole('admin'), async (req, res) => {
  const { name } = req.params;
  // Names are server-generated (above); anything else is rejected, which also
  // rules out path tricks like "../".
  if (!/^[\w-]+\.(jpg|png|webp)$/.test(name)) {
    return res.status(400).json({ error: 'Invalid photo name' });
  }

  const { error } = await supabase.storage.from(BUCKET).remove([name]);
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ message: 'Photo removed' });
});

export default router;
