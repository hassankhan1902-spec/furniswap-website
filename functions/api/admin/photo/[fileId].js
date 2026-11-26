// GET /api/admin/photo/:fileId: streams a submission photo from Drive to the admin page.
// The drive.file scope means only files this website created can be read.
import { adminJson } from '../_middleware.js';
import { getAccessToken, downloadFile } from '../../../_lib/drive.js';

export async function onRequestGet({ env, params }) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(params.fileId || '')) return adminJson(404, { ok: false, error: 'Not found.' });
  const token = await getAccessToken(env);
  const res = await downloadFile(token, params.fileId).catch(() => null);
  if (!res) return adminJson(404, { ok: false, error: 'Not found.' });
  const type = String(res.headers.get('content-type') || '');
  if (!type.startsWith('image/')) return adminJson(404, { ok: false, error: 'Not found.' });
  return new Response(res.body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' },
  });
}
