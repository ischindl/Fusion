import { randomUUID } from "node:crypto";
import type { Database } from "@fusion/core";
import {
  InvalidCredentialPlacementError,
  OAuthNotSupportedError,
  type CliArtifact,
  type CliArtifactCreateInput,
  type CliArtifactUpdateInput,
  type CliSpec,
  type CliSpecCreateInput,
  type CliSpecUpdateInput,
  type Credential,
  type CredentialCreateInput,
  type CredentialUpdateInput,
  type Service,
  type ServiceCreateInput,
  type ServiceSetting,
  type ServiceSettingCreateInput,
  type ServiceUpdateInput,
} from "./cli-press-types.js";

interface ServiceRow {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  baseUrl: string;
  sourceKind: Service["sourceKind"];
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CliSpecRow {
  id: string;
  serviceId: string;
  name: string;
  version: string;
  generatorVersion: string;
  specJson: string;
  generatedAt: string | null;
  status: CliSpec["status"];
  lastGenerationError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CliArtifactRow {
  id: string;
  cliSpecId: string;
  kind: CliArtifact["kind"];
  path: string;
  executable: number;
  checksum: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CredentialRow {
  id: string;
  serviceId: string;
  name: string;
  kind: Credential["kind"];
  value: string;
  placement: string;
  createdAt: string;
  updatedAt: string;
}

interface ServiceSettingRow {
  id: string;
  serviceId: string;
  key: string;
  value: string;
  scope: ServiceSetting["scope"];
  createdAt: string;
  updatedAt: string;
}

const OAUTH_KINDS = new Set(["oauth", "oauth2"]);

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: "svc" | "cli" | "art" | "cred" | "set"): string {
  return `${prefix}_${randomUUID()}`;
}

function assertCredentialSupported(kind: string): void {
  if (OAUTH_KINDS.has(kind)) {
    throw new OAuthNotSupportedError(kind);
  }
}

function assertPlacementConsistency(
  kind: Credential["kind"] | string,
  placement: Credential["placement"] | { kind?: string; header?: string; queryParam?: string },
): void {
  const placementKind = (placement as { kind?: string }).kind;
  if (placementKind !== kind) {
    throw new InvalidCredentialPlacementError({ credentialKind: kind, placementKind: String(placementKind) });
  }
  if (kind === "api_key") {
    const candidate = placement as { kind?: string; header?: string; queryParam?: string };
    const hasHeader = typeof candidate.header === "string" && candidate.header.trim().length > 0;
    const hasQuery = typeof candidate.queryParam === "string" && candidate.queryParam.trim().length > 0;
    if ((hasHeader ? 1 : 0) + (hasQuery ? 1 : 0) !== 1) {
      throw new InvalidCredentialPlacementError({ credentialKind: kind, placementKind: String(placementKind) });
    }
  }
}

export function ensureCliPressSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_press_services (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      description TEXT,
      baseUrl TEXT NOT NULL,
      sourceKind TEXT NOT NULL,
      sourceRef TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_press_cli_specs (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      generatorVersion TEXT NOT NULL,
      specJson TEXT NOT NULL,
      generatedAt TEXT,
      status TEXT NOT NULL,
      lastGenerationError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, name)
    );

    CREATE TABLE IF NOT EXISTS cli_press_artifacts (
      id TEXT PRIMARY KEY,
      cliSpecId TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      executable INTEGER NOT NULL,
      checksum TEXT,
      sizeBytes INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (cliSpecId) REFERENCES cli_press_cli_specs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cli_press_credentials (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      placement TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, name)
    );

    CREATE TABLE IF NOT EXISTS cli_press_service_settings (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, key, scope)
    );

    CREATE INDEX IF NOT EXISTS idx_cli_press_specs_service ON cli_press_cli_specs(serviceId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_artifacts_spec ON cli_press_artifacts(cliSpecId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_credentials_service ON cli_press_credentials(serviceId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_settings_service ON cli_press_service_settings(serviceId);
  `);
}

export function createCliPressStore(db: Database) {
  ensureCliPressSchema(db);

  const mapService = (row: ServiceRow): Service => ({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? undefined,
    baseUrl: row.baseUrl,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const mapSpec = (row: CliSpecRow): CliSpec => ({
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    version: row.version,
    generatorVersion: row.generatorVersion,
    specJson: row.specJson,
    generatedAt: row.generatedAt ?? undefined,
    status: row.status,
    lastGenerationError: row.lastGenerationError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const mapArtifact = (row: CliArtifactRow): CliArtifact => ({
    id: row.id,
    cliSpecId: row.cliSpecId,
    kind: row.kind,
    path: row.path,
    executable: Boolean(row.executable),
    checksum: row.checksum ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const mapCredential = (row: CredentialRow): Credential => ({
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    kind: row.kind,
    value: parseJson(row.value),
    placement: parseJson(row.placement),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const mapSetting = (row: ServiceSettingRow): ServiceSetting => ({
    id: row.id,
    serviceId: row.serviceId,
    key: row.key,
    value: row.value,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  return {
    listServices(): Service[] {
      const rows = db.prepare("SELECT * FROM cli_press_services ORDER BY createdAt DESC").all() as unknown as ServiceRow[];
      return rows.map(mapService);
    },

    getService(id: string): Service | undefined {
      const row = db.prepare("SELECT * FROM cli_press_services WHERE id = ?").get(id) as unknown as ServiceRow | undefined;
      return row ? mapService(row) : undefined;
    },

    createService(input: ServiceCreateInput): Service {
      const service: Service = { id: createId("svc"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      db.prepare(`INSERT INTO cli_press_services (id, slug, displayName, description, baseUrl, sourceKind, sourceRef, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(service.id, service.slug, service.displayName, service.description ?? null, service.baseUrl, service.sourceKind, service.sourceRef ?? null, service.createdAt, service.updatedAt);
      db.bumpLastModified();
      return service;
    },

    updateService(id: string, updates: ServiceUpdateInput): Service {
      const existing = this.getService(id);
      if (!existing) throw new Error(`Service ${id} not found`);
      const updated: Service = { ...existing, ...updates, id: existing.id, slug: existing.slug, createdAt: existing.createdAt, updatedAt: nowIso() };
      db.prepare(`UPDATE cli_press_services SET displayName = ?, description = ?, baseUrl = ?, sourceKind = ?, sourceRef = ?, updatedAt = ? WHERE id = ?`)
        .run(updated.displayName, updated.description ?? null, updated.baseUrl, updated.sourceKind, updated.sourceRef ?? null, updated.updatedAt, id);
      db.bumpLastModified();
      return updated;
    },

    deleteService(id: string): void {
      db.transaction(() => {
        db.prepare("DELETE FROM cli_press_services WHERE id = ?").run(id);
      });
      db.bumpLastModified();
    },

    listSpecs(serviceId: string): CliSpec[] {
      const rows = db.prepare("SELECT * FROM cli_press_cli_specs WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as CliSpecRow[];
      return rows.map(mapSpec);
    },

    getSpec(id: string): CliSpec | undefined {
      const row = db.prepare("SELECT * FROM cli_press_cli_specs WHERE id = ?").get(id) as unknown as CliSpecRow | undefined;
      return row ? mapSpec(row) : undefined;
    },

    createSpec(input: CliSpecCreateInput): CliSpec {
      const spec: CliSpec = { id: createId("cli"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      db.prepare(`INSERT INTO cli_press_cli_specs (id, serviceId, name, version, generatorVersion, specJson, generatedAt, status, lastGenerationError, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(spec.id, spec.serviceId, spec.name, spec.version, spec.generatorVersion, spec.specJson, spec.generatedAt ?? null, spec.status, spec.lastGenerationError ?? null, spec.createdAt, spec.updatedAt);
      db.bumpLastModified();
      return spec;
    },

    updateSpec(id: string, updates: CliSpecUpdateInput): CliSpec {
      const existing = this.getSpec(id);
      if (!existing) throw new Error(`Spec ${id} not found`);
      const updated: CliSpec = { ...existing, ...updates, id: existing.id, serviceId: existing.serviceId, createdAt: existing.createdAt, updatedAt: nowIso() };
      db.prepare(`UPDATE cli_press_cli_specs SET name=?, version=?, generatorVersion=?, specJson=?, generatedAt=?, status=?, lastGenerationError=?, updatedAt=? WHERE id=?`)
        .run(updated.name, updated.version, updated.generatorVersion, updated.specJson, updated.generatedAt ?? null, updated.status, updated.lastGenerationError ?? null, updated.updatedAt, id);
      db.bumpLastModified();
      return updated;
    },

    deleteSpec(id: string): void {
      db.prepare("DELETE FROM cli_press_cli_specs WHERE id = ?").run(id);
      db.bumpLastModified();
    },

    listArtifacts(specId: string): CliArtifact[] {
      const rows = db.prepare("SELECT * FROM cli_press_artifacts WHERE cliSpecId = ? ORDER BY createdAt DESC").all(specId) as unknown as CliArtifactRow[];
      return rows.map(mapArtifact);
    },

    createArtifact(input: CliArtifactCreateInput): CliArtifact {
      const artifact: CliArtifact = { id: createId("art"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      db.prepare(`INSERT INTO cli_press_artifacts (id, cliSpecId, kind, path, executable, checksum, sizeBytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(artifact.id, artifact.cliSpecId, artifact.kind, artifact.path, artifact.executable ? 1 : 0, artifact.checksum ?? null, artifact.sizeBytes ?? null, artifact.createdAt, artifact.updatedAt);
      db.bumpLastModified();
      return artifact;
    },

    updateArtifact(id: string, updates: CliArtifactUpdateInput): CliArtifact {
      const existing = db.prepare("SELECT * FROM cli_press_artifacts WHERE id = ?").get(id) as unknown as CliArtifactRow | undefined;
      if (!existing) throw new Error(`Artifact ${id} not found`);
      const updated = { ...mapArtifact(existing), ...updates, id: existing.id, cliSpecId: existing.cliSpecId, createdAt: existing.createdAt, updatedAt: nowIso() };
      db.prepare("UPDATE cli_press_artifacts SET path=?, executable=?, checksum=?, sizeBytes=?, updatedAt=? WHERE id=?")
        .run(updated.path, updated.executable ? 1 : 0, updated.checksum ?? null, updated.sizeBytes ?? null, updated.updatedAt, id);
      db.bumpLastModified();
      return updated;
    },

    deleteArtifact(id: string): void {
      db.prepare("DELETE FROM cli_press_artifacts WHERE id = ?").run(id);
      db.bumpLastModified();
    },

    listCredentials(serviceId: string): Credential[] {
      const rows = db.prepare("SELECT * FROM cli_press_credentials WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as CredentialRow[];
      return rows.map(mapCredential);
    },

    createCredential(input: CredentialCreateInput): Credential {
      assertCredentialSupported(input.kind);
      assertPlacementConsistency(input.kind, input.placement);
      const cred: Credential = { id: createId("cred"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      db.prepare(`INSERT INTO cli_press_credentials (id, serviceId, name, kind, value, placement, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cred.id, cred.serviceId, cred.name, cred.kind, JSON.stringify(cred.value), JSON.stringify(cred.placement), cred.createdAt, cred.updatedAt);
      db.bumpLastModified();
      return cred;
    },

    updateCredential(id: string, updates: CredentialUpdateInput): Credential {
      const existing = db.prepare("SELECT * FROM cli_press_credentials WHERE id = ?").get(id) as unknown as CredentialRow | undefined;
      if (!existing) throw new Error(`Credential ${id} not found`);
      const mapped = mapCredential(existing);
      const updated: Credential = {
        ...mapped,
        ...updates,
        id: mapped.id,
        serviceId: mapped.serviceId,
        kind: mapped.kind,
        createdAt: mapped.createdAt,
        updatedAt: nowIso(),
      };
      assertCredentialSupported(updated.kind);
      assertPlacementConsistency(updated.kind, updated.placement);
      db.prepare("UPDATE cli_press_credentials SET name=?, value=?, placement=?, updatedAt=? WHERE id=?")
        .run(updated.name, JSON.stringify(updated.value), JSON.stringify(updated.placement), updated.updatedAt, id);
      db.bumpLastModified();
      return updated;
    },

    deleteCredential(id: string): void {
      db.prepare("DELETE FROM cli_press_credentials WHERE id = ?").run(id);
      db.bumpLastModified();
    },

    listSettings(serviceId: string): ServiceSetting[] {
      const rows = db.prepare("SELECT * FROM cli_press_service_settings WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as ServiceSettingRow[];
      return rows.map(mapSetting);
    },

    setSetting(input: ServiceSettingCreateInput): ServiceSetting {
      const existing = db.prepare("SELECT * FROM cli_press_service_settings WHERE serviceId = ? AND key = ? AND scope = ?")
        .get(input.serviceId, input.key, input.scope) as unknown as ServiceSettingRow | undefined;
      const now = nowIso();
      if (existing) {
        db.prepare("UPDATE cli_press_service_settings SET value = ?, updatedAt = ? WHERE id = ?").run(input.value, now, existing.id);
        db.bumpLastModified();
        return mapSetting({ ...existing, value: input.value, updatedAt: now });
      }
      const setting: ServiceSetting = { id: createId("set"), ...input, createdAt: now, updatedAt: now };
      db.prepare(`INSERT INTO cli_press_service_settings (id, serviceId, key, value, scope, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(setting.id, setting.serviceId, setting.key, setting.value, setting.scope, setting.createdAt, setting.updatedAt);
      db.bumpLastModified();
      return setting;
    },

    deleteSetting(id: string): void {
      db.prepare("DELETE FROM cli_press_service_settings WHERE id = ?").run(id);
      db.bumpLastModified();
    },
  };
}

export type CliPressStore = ReturnType<typeof createCliPressStore>;
