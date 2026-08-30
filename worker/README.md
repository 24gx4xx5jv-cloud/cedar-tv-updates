# Cedar Sync relay

This optional Cloudflare Worker/D1 service stores Cedar's opaque encrypted change journal. It does
not receive the shared profile key or plaintext profile data.

## Local verification

```sh
npm install
npm run check
npm test
npm run migrate:local
npm run dev
```

With the local Worker running in another terminal, `npm run test:integration` verifies space
creation, single-use enrollment, authenticated idempotent upload/fetch, owner-authored checkpoint
baselines, unauthorized rejection, owner-only device listing, and owner-only revocation. The first
device in a space is its owner; linked devices can sync normally and publish their own content-free
companion checkpoints, but cannot publish owner profile checkpoints, enumerate devices, or revoke
other devices.

## Production deployment

1. Run `npx wrangler login` and `npx wrangler d1 create cedar-sync`.
2. Copy `wrangler.example.toml` to the ignored `wrangler.toml`.
3. Replace the zero D1 database ID, choose two account-unique integer rate-limit namespace IDs,
   and verify the exact `CEDAR_WEB_ORIGIN`.
4. Run `npm run migrate:remote`, then `npm run deploy`.
5. Put the resulting exact HTTPS origin in `public/sync-config.json` and in the `/link/` page's
   `connect-src` CSP before publishing Pages.

Do not commit `wrangler.toml`, Cloudflare credentials, Cedar profile keys, device tokens, or
pairing fragments. The checked-in Pages configuration contains only the public production relay
origin; all authorization and encryption material remains device-local or in one-time fragments.
