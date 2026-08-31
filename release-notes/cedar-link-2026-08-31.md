# Cedar Link relay and editor — August 31, 2026

- Bounds encrypted relay storage to one current checkpoint per publisher and prunes only journal data represented by both owner checkpoints.
- Adds durable replay receipts, 50-device and 64-invitation limits, a 1,900-change / 32 MiB journal suffix ceiling, and retryable device/space deletion.
- Lets a linked browser unlink itself from the relay before its protected local key is erased.
- Keeps link creation owner-only in Cedar and limits browser-created Home rows to portable catalog presets.
- Preserves the current editor's draft savebar, revision-conflict handling, focus restoration, encrypted device actions, and transport-only remote controls.
- Production migration reduced retained checkpoint rows from 2,167 to 5 without deleting journal entries; D1 recovery bookmark was captured before rollout.
