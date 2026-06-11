import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Resolve a Bearer token to a { ...user, profile } object, or null if the
// token is missing/invalid. Shared by requireAuth (hard) and optionalAuth (soft).
async function resolveUser(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return null;

  // Verify the token using anon key (user-facing client)
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { data: { user }, error } = await anonClient.auth.getUser(token);

  if (error || !user) return null;

  // Fetch the profile for role information using service role key
  const adminClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) return null;

  return { ...user, profile };
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
}

// Soft authentication: if a valid Bearer token is present, attach req.user;
// otherwise set req.user = null and continue (never 401). Used for endpoints
// that support both signed-in and guest callers (e.g. guest booking).
export async function optionalAuth(req, res, next) {
  req.user = await resolveUser(req);
  next();
}
