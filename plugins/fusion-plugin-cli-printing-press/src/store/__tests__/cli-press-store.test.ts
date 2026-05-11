import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliPressStore, ensureCliPressSchema } from "../cli-press-store.js";
import { encodeCredentialValue } from "../credentials.js";

describe("cli-press-store", () => {
  let rootDir: string;
  let db: Database;
  let store: ReturnType<typeof createCliPressStore>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "cli-press-store-"));
    db = new Database(join(rootDir, ".fusion"), { inMemory: true });
    db.init();
    ensureCliPressSchema(db);
    ensureCliPressSchema(db);
    store = createCliPressStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates schema idempotently and runs full CRUD", () => {
    const service = store.createService({
      slug: "demo",
      displayName: "Demo",
      description: "Demo service",
      baseUrl: "https://example.com",
      sourceKind: "manual",
      sourceRef: "wizard",
    });
    expect(service.id).toMatch(/^svc_/);

    const updatedService = store.updateService(service.id, { displayName: "Demo Updated" });
    expect(updatedService.displayName).toBe("Demo Updated");

    const spec = store.createSpec({
      serviceId: service.id,
      name: "demo-cli",
      version: "0.1.0",
      generatorVersion: "1.0.0",
      specJson: JSON.stringify({ hello: "world" }),
      status: "draft",
      generatedAt: undefined,
      lastGenerationError: undefined,
    });
    expect(store.getSpec(spec.id)?.specJson).toBe(JSON.stringify({ hello: "world" }));

    const updatedSpec = store.updateSpec(spec.id, { status: "generated" });
    expect(updatedSpec.status).toBe("generated");

    const artifact = store.createArtifact({
      cliSpecId: spec.id,
      kind: "script",
      path: "plugins/cli-printing-press/artifacts/demo.sh",
      executable: true,
      checksum: "abc",
      sizeBytes: 42,
    });
    expect(artifact.id).toMatch(/^art_/);

    const cred = store.createCredential({
      serviceId: service.id,
      name: "api",
      kind: "api_key",
      value: encodeCredentialValue("secret"),
      placement: { kind: "api_key", header: "X-API-Key" },
    });
    expect(cred.id).toMatch(/^cred_/);

    const setting = store.setSetting({
      serviceId: service.id,
      key: "region",
      value: "us-east-1",
      scope: "runtime",
    });
    expect(setting.id).toMatch(/^set_/);

    expect(store.listServices()).toHaveLength(1);
    expect(store.listSpecs(service.id)).toHaveLength(1);
    expect(store.listArtifacts(spec.id)).toHaveLength(1);
    expect(store.listCredentials(service.id)).toHaveLength(1);
    expect(store.listSettings(service.id)).toHaveLength(1);

    store.deleteService(service.id);
    expect(store.listServices()).toHaveLength(0);
    expect(store.listSpecs(service.id)).toHaveLength(0);
    expect(store.listCredentials(service.id)).toHaveLength(0);
    expect(store.listSettings(service.id)).toHaveLength(0);
  });

  it("rejects oauth and invalid placement", () => {
    const service = store.createService({
      slug: "oauth-demo",
      displayName: "OAuth Demo",
      description: "",
      baseUrl: "https://example.com",
      sourceKind: "manual",
      sourceRef: "wizard",
    });

    expect(() =>
      store.createCredential({
        serviceId: service.id,
        name: "bad",
        kind: "oauth" as never,
        value: encodeCredentialValue("x"),
        placement: { kind: "header", header: "Authorization" },
      }),
    ).toThrow("not supported");

    expect(() =>
      store.createCredential({
        serviceId: service.id,
        name: "bad2",
        kind: "api_key",
        value: encodeCredentialValue("x"),
        placement: { kind: "api_key", header: "X", queryParam: "token" },
      }),
    ).toThrow("Invalid credential placement");
  });
});
