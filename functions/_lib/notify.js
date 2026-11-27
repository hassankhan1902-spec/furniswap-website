// New-upload email notification via the Cloudflare Email Sending REST API.
// (Pages Functions have no send_email binding, so this uses fetch + an API token.)
//
// Environment variables (Cloudflare Pages → Settings → Variables and Secrets):
//   NOTIFY_EMAIL_TO      where notifications go; comma-separated for several (required)
//   CF_ACCOUNT_ID        Cloudflare account ID (required)
//   CF_EMAIL_API_TOKEN   API token with "Email Sending: Send" permission (required, secret)
//   NOTIFY_EMAIL_FROM    sender address on an onboarded domain (default quotes@furniswap.pk)
//
// If any required value is missing, notifications are silently skipped.

const SITE = 'https://furniswap.pk';

export function hasEmailConfig(env) {
  return !!(env.NOTIFY_EMAIL_TO && env.CF_ACCOUNT_ID && env.CF_EMAIL_API_TOKEN);
}

export async function sendUploadNotification(env, submission) {
  if (!hasEmailConfig(env)) return;
  const { id, customer, photos, driveFolderId, createdAt, lang } = submission;
  const to = String(env.NOTIFY_EMAIL_TO).split(',').map(s => s.trim()).filter(Boolean);
  const from = env.NOTIFY_EMAIL_FROM || 'quotes@furniswap.pk';
  const driveUrl = `https://drive.google.com/drive/folders/${driveFolderId}`;
  const waUrl = `https://wa.me/${customer.whatsapp}`;
  const adminUrl = `${SITE}/admin`;
  const when = new Date(createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' });

  const text = [
    `New photo quote: ${id}`,
    '',
    `Name:      ${customer.name}`,
    `WhatsApp:  +${customer.whatsapp}  (${waUrl})`,
    `Photos:    ${photos.length}`,
    `Language:  ${lang === 'ur' ? 'Urdu' : 'English'}`,
    `Received:  ${when} (PKT)`,
    '',
    `Photos in Google Drive: ${driveUrl}`,
    `Admin page: ${adminUrl}`,
  ].join('\n');

  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td style="padding:4px 0">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222">
<h2 style="margin:0 0 12px">New photo quote <span style="color:#888;font-weight:normal">${esc(id)}</span></h2>
<table style="border-collapse:collapse">
${row('Name', esc(customer.name))}
${row('WhatsApp', `<a href="${waUrl}">+${esc(customer.whatsapp)}</a>`)}
${row('Photos', photos.length)}
${row('Language', lang === 'ur' ? 'Urdu' : 'English')}
${row('Received', `${esc(when)} (PKT)`)}
</table>
<p style="margin-top:16px"><a href="${driveUrl}" style="background:#1a73e8;color:#fff;padding:9px 14px;border-radius:6px;text-decoration:none">Open photos in Drive</a>
&nbsp; <a href="${adminUrl}">Admin page</a></p>
</div>`;

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: to.length === 1 ? to[0] : to,
      from: { address: from, name: 'FurniSwap Quotes' },
      subject: `New photo quote: ${customer.name} (${photos.length} photo${photos.length === 1 ? '' : 's'})`,
      text,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    console.error('upload notification email failed:', res.status, JSON.stringify(data.errors || data).slice(0, 500));
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
