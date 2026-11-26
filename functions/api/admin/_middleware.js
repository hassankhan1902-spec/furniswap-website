// Every /api/admin/* request must carry a valid Cloudflare Access login.
import { verifyAccess } from '../../_lib/access.js';
import { hasGoogleCredentials } from '../../_lib/drive.js';

export async function onRequest(context) {
  const auth = await verifyAccess(context.request, context.env);
  if (!auth.ok) return adminJson(auth.status, { ok: false, error: auth.error });
  if (!hasGoogleCredentials(context.env)) return adminJson(503, { ok: false, error: 'Google Drive is not configured.' });
  context.data.adminEmail = auth.email;
  try {
    return await context.next();
  } catch (err) {
    console.error('admin api failed:', err && err.stack ? err.stack : err);
    return adminJson(500, { ok: false, error: 'Something went wrong.', code: (err && err.code) || 'internal' });
  }
}

export function adminJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
