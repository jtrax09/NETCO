# NETCO Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. Default-deny catch-all at root blocks all unlisted collections and operations.
2. Only verified authenticated admins (`isAdmin()` with `request.auth.token.email_verified == true`) can create, update, or delete `/admins/{adminId}` or `/packages/{packageId}`.
3. Users can never self-assign or escalate their own role in `/admins/{adminId}` or inject shadow fields.
4. All document IDs are strictly validated against `^[a-zA-Z0-9_-]+$` and `<= 128` characters.
5. Every string field enforces `.size()` limits; every write validates exact allowed keys via `hasAll` and `hasOnly` (and `affectedKeys().hasOnly()` on updates).
6. All `updatedAt` timestamps on Firestore writes must equal `request.time`.
7. Private user preferences in `/workspace_prefs/{userId}` are strictly isolated to `request.auth.uid == userId` and cannot contain PII or cross-user reads/lists.
8. Sensitive server-only secrets (MikroTik router passwords, mobile money webhook secrets, staff scrypt password hashes, raw voucher credentials) are NEVER stored in Firestore and remain exclusively on the Node.js backend.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. Unauthenticated write to `/packages/pkg1`
2. Authenticated non-admin write to `/packages/pkg1`
3. Authenticated non-admin creating `/admins/hacker` with `role: "SUPER_ADMIN"`
4. Admin writing `/packages/pkg1` with an extra shadow field `isFreeOverride: true`
5. Admin writing `/packages/pkg1` with `name` > 80 characters (resource poisoning)
6. Unverified email (`email_verified: false`) matching admin email attempting read/write on `/admins/{id}`
7. Writing document ID `../../escape` or 500-char junk ID to `/workspace_prefs/{id}`
8. User A attempting to `get` or `update` `/workspace_prefs/userB`
9. User attempting `list` across `/workspace_prefs` without `ownerUid == request.auth.uid`
10. Admin updating `/packages/pkg1` with client-forged timestamp (`updatedAt != request.time`)
11. User updating `/workspace_prefs/userA` while changing `ownerUid` to `userB`
12. Read/write to unlisted collection `/routers/r1` or `/vouchers/v1`
