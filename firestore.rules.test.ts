import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Firestore Security Rules Structural Audit', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');

  it('enforces rules_version 2 and default-deny catch-all', () => {
    const rules = fs.readFileSync(rulesPath, 'utf8');
    expect(rules).toContain("rules_version = '2';");
    expect(rules).toContain('match /{document=**}');
    expect(rules).toContain('allow read, write: if false;');
  });

  it('enforces verified email, strict key checks, size limits, and immutable owner checks', () => {
    const rules = fs.readFileSync(rulesPath, 'utf8');
    expect(rules).toContain('request.auth.token.email_verified == true');
    expect(rules).toContain('isValidId(');
    expect(rules).toContain('hasOnly(');
    expect(rules).toContain('hasAll(');
    expect(rules).toContain('affectedKeys().hasOnly(');
    expect(rules).toContain('request.time');
    expect(rules).toContain('resource.data.ownerUid == request.auth.uid');
  });

  it('covers every collection declared in firebase-blueprint.json', () => {
    const blueprint = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'firebase-blueprint.json'), 'utf8'));
    const rules = fs.readFileSync(rulesPath, 'utf8');
    expect(Object.keys(blueprint.firestore)).toContain('/admins/{adminId}');
    expect(Object.keys(blueprint.firestore)).toContain('/packages/{packageId}');
    expect(Object.keys(blueprint.firestore)).toContain('/workspace_prefs/{userId}');
    expect(rules).toContain('match /admins/{adminId}');
    expect(rules).toContain('match /packages/{packageId}');
    expect(rules).toContain('match /workspace_prefs/{userId}');
  });
});
