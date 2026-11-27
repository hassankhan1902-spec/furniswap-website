# Photo Quote: one-time setup

The upload form (`#photo-quote` in `index.html`) posts to the Cloudflare Pages Function
`functions/api/quote-upload.js`. That function saves each submission into Google Drive:

```
My Drive / FurniSwap Quotes / FS-20261125-7K3Q - Customer Name /
    FS-20261125-7K3Q-photo-1.jpg
    FS-20261125-7K3Q-photo-2.jpg
    submission.json      ← name, WhatsApp number, time, status: "new"
```

Until the Google credentials below are added, the form shows
"Photo upload is not available yet. Please send your photos on WhatsApp."

## 1. Google Cloud: enable Drive and create an OAuth client (~10 min)

Use the Google account whose Drive should store the photos.

1. Open https://console.cloud.google.com/ → project picker → **New project** → name it `FurniSwap`.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **Google Auth Platform → Branding**: app name `FurniSwap Quotes`, your support email, save.
4. **Audience**: user type **External**, then click **Publish app** so the status is
   **In production**. *Important:* in "Testing" status Google expires the refresh token after
   7 days and uploads stop working. No Google review is needed for the scope we use.
5. **Data access → Add or remove scopes** → add `https://www.googleapis.com/auth/drive.file`
   (the app can only see files it creates itself, not the rest of your Drive).
6. **Clients → Create client** → type **Web application** →
   under *Authorized redirect URIs* add `https://developers.google.com/oauthplayground` → Create.
   Keep the **Client ID** and **Client secret** handy.

## 2. Get a refresh token (OAuth Playground, ~3 min)

1. Open https://developers.google.com/oauthplayground
2. Gear icon (top right) → tick **Use your own OAuth credentials** → paste the Client ID and secret.
3. In *Step 1*, type `https://www.googleapis.com/auth/drive.file` in the box → **Authorize APIs**.
   Sign in with the Drive account. If you see "Google hasn't verified this app", choose
   **Advanced → Go to FurniSwap Quotes**.
4. In *Step 2*, click **Exchange authorization code for tokens** and copy the **Refresh token**.

## 3. Add the values to Cloudflare Pages

Cloudflare dashboard → **Workers & Pages → furniswap-website → Settings → Variables and Secrets**,
environment **Production** (repeat for **Preview** if you want to test preview URLs):

| Name | Type | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Text | Client ID from step 1 |
| `GOOGLE_CLIENT_SECRET` | Secret | Client secret from step 1 |
| `GOOGLE_REFRESH_TOKEN` | Secret | Refresh token from step 2 |
| `DRIVE_ROOT_FOLDER_ID` | Text (optional) | Leave unset: the function creates **FurniSwap Quotes** in My Drive |

Variables only apply to new deployments: after saving, push a commit or use
**Deployments → ⋯ → Retry deployment** on the latest one.

## 4. Spam protection (Turnstile, optional but recommended)

1. Cloudflare dashboard → **Turnstile → Add widget** → hostnames `furniswap.pk`,
   `www.furniswap.pk`, `furniswap-website.pages.dev` → mode **Managed**.
2. Put the **site key** (public) into `PQ_TURNSTILE_SITE_KEY` near the bottom of `index.html`
   (and the identical `furniswap-website.html`).
3. Add the **secret key** as a Pages secret named `TURNSTILE_SECRET`.

Without Turnstile, the form still has a hidden honeypot field and file-count/size limits.

## Test

On the live site, open **#photo-quote**, enter a name and number, add 2–3 phone photos and send.
You should get a reference like `FS-20261125-7K3Q`, and a matching folder in Drive within seconds
(each photo ≈ 300–400 KB, 1600 px on the long edge). If it fails, check
**Workers & Pages → furniswap-website → Functions → Real-time logs** for the `quote-upload` error.

## Email notification for each upload

`functions/_lib/notify.js` emails the owner after every successful upload (name, WhatsApp
link, photo count, link to the Drive folder). It uses the Cloudflare Email Sending REST API,
because Pages Functions have no `send_email` binding. It runs in the background and never
blocks or fails the upload.

- **Email Service → Email Sending**: furniswap.pk is onboarded (records on `cf-bounce.furniswap.pk`
  plus `_dmarc`). On the free plan you can only send to *verified destination addresses*
  (Email Service → Email Routing → Destination addresses).
- **Pages variables (Production)**: `NOTIFY_EMAIL_TO` (comma-separated for several),
  `CF_ACCOUNT_ID`, `CF_EMAIL_API_TOKEN` (secret; account API token with **Email Sending: Edit**),
  optional `NOTIFY_EMAIL_FROM` (default `quotes@furniswap.pk`).
- If an email doesn't arrive, check spam, then **Functions → Real-time logs** for
  `upload notification email failed`.
