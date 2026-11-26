// GET /api/admin/submissions: newest submissions with their status and AI price range.
import { adminJson } from './_middleware.js';
import { getAccessToken, listSubmissionFolders } from '../../_lib/drive.js';
import { STALE_PRICING_MS } from '../../_lib/pricing.js';

export async function onRequestGet({ env, data }) {
  const token = await getAccessToken(env);
  const folders = await listSubmissionFolders(env, token, 100);
  const now = Date.now();
  const items = folders.map(f => {
    const p = f.appProperties || {};
    let status = p.status || 'new';
    if (status === 'pricing' && now - Number(p.pricingStartedAt || 0) > STALE_PRICING_MS) status = 'stalled';
    const m = /^(FS-\d{8}-[A-Z0-9]{4})\s*-\s*(.*)$/.exec(f.name || '');
    return {
      folderId: f.id,
      id: p.fsId || (m ? m[1] : f.name),
      customerName: m ? m[2] : '',
      createdTime: f.createdTime,
      status,
      minCredit: p.minCredit ? Number(p.minCredit) : null,
      maxCredit: p.maxCredit ? Number(p.maxCredit) : null,
      finalCredit: p.finalCredit ? Number(p.finalCredit) : null,
      typeKey: p.typeKey || null,
      flags: p.flags ? p.flags.split(',').filter(Boolean) : [],
      error: p.error || null,
    };
  });
  return adminJson(200, { ok: true, admin: data.adminEmail, aiEnabled: !!env.ANTHROPIC_API_KEY, items });
}
