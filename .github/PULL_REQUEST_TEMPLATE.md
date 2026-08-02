## What changed

<!-- One paragraph. What does this do and why? -->

## Type

- [ ] feature
- [ ] fix
- [ ] chore
- [ ] release
- [ ] hotfix

## Privacy and consent review

This product locates people. Every change is reviewed against the consent model.

- [ ] No change to what location data is collected, or the change is described above.
- [ ] No new code path can produce a stored location for a user who has not
      authenticated, joined a family, enabled sharing, and granted OS permissions.
- [ ] The user can still see that sharing is active, and can still pause, revoke,
      leave, delete history, and delete their account.
- [ ] No exact coordinate is written to logs, metrics, traces, Sentry, analytics,
      push payloads, URLs, or error messages.
- [ ] Authorization for any new sensitive read is checked server-side against
      family membership records, not client claims.
- [ ] Any new sensitive read writes an audit event.

## Security

- [ ] No secret, key, certificate, or `.env` file is added to the repository.
- [ ] New endpoints are rate limited and validate input against a shared schema.
- [ ] Mutating endpoints accept and honour an idempotency key.
- [ ] Threat model (`docs/architecture/security-model.md`) updated if the attack
      surface changed.

## Infrastructure changes (required if `infrastructure/` changed — spec §14)

- **CDK diff:** <!-- paste or link the infrastructure-diff comment -->
- **Change summary:**
- **Deployment order:**
- **Data compatibility:** <!-- is this backward compatible with the running code? -->
- **Rollback notes:**
- [ ] Follows expand-and-contract; no destructive change ships in the same
      release as the code that stops using it.

## Data migrations

- [ ] None.
- [ ] Migration added; it is idempotent, resume-safe, checkpointed, dry-run
      capable, and rate limited. Verification and rollback are implemented.

## Mobile

- [ ] `app.config.ts` unchanged, or native projects regenerated and committed.
- [ ] No behaviour requiring App Store review is being shipped via OTA update
      (permissions, billing, or safety-critical location behaviour).
- [ ] Real-device impact considered: battery, background reliability, permission
      downgrade paths.

## Testing

<!-- What did you actually run? Paste the result, not a claim. -->

- [ ] Unit tests added or updated.
- [ ] Tested on a real device (state which, and which scenarios).
- [ ] Not applicable, because:

## Changeset

- [ ] `pnpm changeset` run for any user-visible change.
