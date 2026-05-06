import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
import type {
  ProjectAuthMembership,
  ProjectAuthMembershipCreateInput,
  ProjectAuthProvider,
  ProjectAuthProviderCreateInput,
  ProjectAuthRole,
  ProjectAuthSession,
  ProjectAuthSessionCreateInput,
  ProjectAuthUser,
  ProjectAuthUserCreateInput,
} from "./types.js";
import { PROJECT_AUTH_ROLES } from "./types.js";

interface ProjectAuthUserRow { id: string; email: string; displayName: string | null; active: number; createdAt: string; updatedAt: string; }
interface ProjectAuthMembershipRow { id: string; userId: string; role: ProjectAuthRole; active: number; createdAt: string; updatedAt: string; }
interface ProjectAuthProviderRow { id: string; userId: string; provider: string; providerUserId: string; metadata: string | null; createdAt: string; updatedAt: string; }
interface ProjectAuthSessionRow { id: string; userId: string; membershipId: string; sessionToken: string; expiresAt: string; revokedAt: string | null; createdAt: string; updatedAt: string; }

export class ProjectAuthStore extends EventEmitter {
  constructor(private db: Database) { super(); }

  private makeId(prefix: string): string { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`; }
  private now(): string { return new Date().toISOString(); }

  private rowToUser(row: ProjectAuthUserRow): ProjectAuthUser { return { ...row, active: row.active === 1 }; }
  private rowToMembership(row: ProjectAuthMembershipRow): ProjectAuthMembership { return { ...row, active: row.active === 1 }; }
  private rowToProvider(row: ProjectAuthProviderRow): ProjectAuthProvider { return { ...row, metadata: fromJson<Record<string, unknown>>(row.metadata) }; }
  private rowToSession(row: ProjectAuthSessionRow): ProjectAuthSession { return { ...row }; }

  createUser(input: ProjectAuthUserCreateInput): ProjectAuthUser {
    const now = this.now();
    const user: ProjectAuthUser = { id: this.makeId("PAU"), email: input.email, displayName: input.displayName ?? null, active: input.active ?? true, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO project_auth_users (id,email,displayName,active,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(user.id, user.email, user.displayName, user.active ? 1 : 0, now, now);
    this.db.bumpLastModified();
    return user;
  }

  getUser(id: string): ProjectAuthUser | undefined {
    const row = this.db.prepare("SELECT * FROM project_auth_users WHERE id = ?").get(id) as ProjectAuthUserRow | undefined;
    return row ? this.rowToUser(row) : undefined;
  }

  listUsers(): ProjectAuthUser[] {
    return (this.db.prepare("SELECT * FROM project_auth_users ORDER BY createdAt ASC, id ASC").all() as ProjectAuthUserRow[]).map((row) => this.rowToUser(row));
  }

  createMembership(input: ProjectAuthMembershipCreateInput): ProjectAuthMembership {
    if (!PROJECT_AUTH_ROLES.includes(input.role)) throw new Error(`Invalid role: ${input.role}`);
    const now = this.now();
    const membership: ProjectAuthMembership = { id: this.makeId("PAM"), userId: input.userId, role: input.role, active: input.active ?? true, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO project_auth_memberships (id,userId,role,active,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(membership.id, membership.userId, membership.role, membership.active ? 1 : 0, now, now);
    this.db.bumpLastModified();
    return membership;
  }

  listMembershipsByUser(userId: string): ProjectAuthMembership[] {
    return (this.db.prepare("SELECT * FROM project_auth_memberships WHERE userId = ? ORDER BY createdAt ASC, id ASC").all(userId) as ProjectAuthMembershipRow[]).map((row) => this.rowToMembership(row));
  }

  getMembership(id: string): ProjectAuthMembership | undefined {
    const row = this.db.prepare("SELECT * FROM project_auth_memberships WHERE id = ?").get(id) as ProjectAuthMembershipRow | undefined;
    return row ? this.rowToMembership(row) : undefined;
  }

  createProvider(input: ProjectAuthProviderCreateInput): ProjectAuthProvider {
    const now = this.now();
    const provider: ProjectAuthProvider = { id: this.makeId("PAP"), userId: input.userId, provider: input.provider, providerUserId: input.providerUserId, metadata: input.metadata, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO project_auth_providers (id,userId,provider,providerUserId,metadata,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(provider.id, provider.userId, provider.provider, provider.providerUserId, toJsonNullable(provider.metadata), now, now);
    this.db.bumpLastModified();
    return provider;
  }

  listProvidersByUser(userId: string): ProjectAuthProvider[] {
    return (this.db.prepare("SELECT * FROM project_auth_providers WHERE userId = ? ORDER BY createdAt ASC, id ASC").all(userId) as ProjectAuthProviderRow[]).map((row) => this.rowToProvider(row));
  }

  createSession(input: ProjectAuthSessionCreateInput): ProjectAuthSession {
    const now = this.now();
    const session: ProjectAuthSession = { id: this.makeId("PAS"), userId: input.userId, membershipId: input.membershipId, sessionToken: input.sessionToken, expiresAt: input.expiresAt, revokedAt: null, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO project_auth_sessions (id,userId,membershipId,sessionToken,expiresAt,revokedAt,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(session.id, session.userId, session.membershipId, session.sessionToken, session.expiresAt, session.revokedAt, now, now);
    this.db.bumpLastModified();
    return session;
  }

  revokeSession(id: string): ProjectAuthSession | undefined {
    const now = this.now();
    this.db.prepare("UPDATE project_auth_sessions SET revokedAt = ?, updatedAt = ? WHERE id = ?").run(now, now, id);
    this.db.bumpLastModified();
    return this.getSession(id);
  }

  getSession(id: string): ProjectAuthSession | undefined {
    const row = this.db.prepare("SELECT * FROM project_auth_sessions WHERE id = ?").get(id) as ProjectAuthSessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  resolveActiveSessionByToken(sessionToken: string, nowIso: string = this.now()): ProjectAuthSession | undefined {
    const row = this.db.prepare("SELECT * FROM project_auth_sessions WHERE sessionToken = ? AND revokedAt IS NULL AND expiresAt > ?").get(sessionToken, nowIso) as ProjectAuthSessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }
}
