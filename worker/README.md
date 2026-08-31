# Cedar Sync relay

This optional Cloudflare Worker/D1 service stores Cedar's opaque encrypted change journal. It does
not receive a profile key, derived companion key, or plaintext profile data. The authenticated
identity endpoint and claim response expose only the stable owner device ID needed to pin browser
authority; the first device in a space is the owner. Invitation records contain no encryption key
or scope marker, so the owner-only invitation gate applies equally to native full-profile and
browser-companion enrollment.

Uploads may add the relay-only `retentionClass` field. Omission means `journal`;
`profile-checkpoint` is owner-only and `companion-checkpoint` keeps one current row per publisher.
The marker is only a storage hint—the encrypted envelope and its authenticated metadata are
unchanged. A checkpoint must be a complete snapshot created only after its publisher has consumed
all journal entries through its prior cursor. Once the owner has published both checkpoint types,
the relay keeps those baselines, prunes only journal rows at or before the earlier checkpoint
sequence, and bounds the unrepresented suffix to 1,900 rows and 32 MiB of Base64 text. Journal
entries between the two checkpoint sequences and after them remain available. Before that safe
baseline exists, the relay preserves legacy history and rejects the first over-quota write instead
of pruning the only native profile snapshot.

A successful claim returns either `highWaterCursor: 0` with an empty `checkpoints` array, or a
positive high-water cursor with exactly two owner checkpoints, each using the same
`{ serverSequence, envelope }` shape as a changes response. The positive cursor is the earlier of
the current profile and companion checkpoint sequences. New clients require exactly one checkpoint
to authenticate with the profile key and exactly one with the companion key, apply both snapshots,
persist the high-water cursor, then fetch after it. A browser can authenticate only the companion
checkpoint, so it requires exactly one owner companion success and exactly one expected profile-key
authentication failure. Legacy clients ignore the extra response fields and still find the retained
checkpoints by fetching from cursor zero.

Lifecycle endpoints are deliberately retryable:

- `DELETE /v1/spaces/:spaceID` requires the live owner token, atomically erases the space's
  invitations, journal/checkpoints, author receipts, devices, and space, and returns schema-1 HTTP
  200. The same owner token receives 200 for 30 days after deletion; a live non-owner receives 403.
- `DELETE /v1/spaces/:spaceID/devices/:deviceID` lets the owner remove a non-owner or a participant
  remove itself. It hard-deletes that device's invitations and ciphertext, and the departed token
  can retry for 30 days. A participant targeting another device receives 403; an owner targeting
  itself must use the space endpoint.

Per space, the relay accepts at most 50 active devices and 64 unexpired invitation/claim records.
Checkpoint slot limits follow the device quota. Scheduled cleanup removes 30-day deletion receipts.

## Local verification

```sh
npm install
npm run check
npm test
npm run migrate:local
npm run dev
```

With the local Worker running in another terminal, `npm run test:integration` verifies space
creation, single-use enrollment, authenticated idempotent upload/fetch, unauthorized rejection,
owner-only invitation creation, the 50-device enrollment bound, stable owner identity, owner-only
device listing, participant self-leave, checkpoint compaction/high-water enrollment, quotas, and
retryable owner deletion. The checkpoint test also proves that journal entries between the two
checkpoint sequences and after the later checkpoint remain in catch-up results. Linked devices can
sync normally but cannot mint browser links, enumerate devices, or revoke other devices. If
enrollment fails after an invitation is
conditionally consumed, the Worker restores that exact invitation. A process interruption between
claim and enrollment is recovered by an idempotent retry with the same device ID and token.

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
