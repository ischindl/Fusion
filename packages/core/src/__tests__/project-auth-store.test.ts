import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database } from "../db.js";
import { ProjectAuthStore } from "../project-auth-store.js";

describe("ProjectAuthStore", () => {
  let tmpDir: string;
  let db: Database;
  let store: ProjectAuthStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-project-auth-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
    store = new ProjectAuthStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists users memberships providers and active sessions", () => {
    const user = store.createUser({ email: "owner@example.com", displayName: "Owner" });
    const membership = store.createMembership({ userId: user.id, role: "owner" });
    const provider = store.createProvider({ userId: user.id, provider: "github", providerUserId: "123", metadata: { login: "owner" } });
    const session = store.createSession({ userId: user.id, membershipId: membership.id, sessionToken: "tok_1", expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.getUser(user.id)?.email).toBe("owner@example.com");
    expect(store.listMembershipsByUser(user.id)[0]?.role).toBe("owner");
    expect(store.listProvidersByUser(user.id)[0]?.provider).toBe("github");
    expect(store.resolveActiveSessionByToken(session.sessionToken)?.id).toBe(session.id);
    expect(provider.metadata).toEqual({ login: "owner" });
  });

  it("treats revoked and expired sessions as inactive", () => {
    const user = store.createUser({ email: "viewer@example.com" });
    const membership = store.createMembership({ userId: user.id, role: "viewer" });

    const active = store.createSession({ userId: user.id, membershipId: membership.id, sessionToken: "tok_active", expiresAt: "2099-01-01T00:00:00.000Z" });
    const expired = store.createSession({ userId: user.id, membershipId: membership.id, sessionToken: "tok_expired", expiresAt: "2000-01-01T00:00:00.000Z" });

    store.revokeSession(active.id);

    expect(store.resolveActiveSessionByToken("tok_active")).toBeUndefined();
    expect(store.resolveActiveSessionByToken("tok_expired")).toBeUndefined();
    expect(expired.expiresAt).toBe("2000-01-01T00:00:00.000Z");
  });
});
