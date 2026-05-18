import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  CentralCore,
  MasterKeyManager,
  RESERVED_SYNC_PASSPHRASE_KEY,
  SecretsStore,
  TaskStore,
  setSyncPassphrase,
  unwrapSecretsBundle,
  wrapSecretsBundle,
} from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";
import * as helpers from "../routes/register-settings-sync-helpers.js";
import { MISSING_REMOTE_NODE_API_KEY_MESSAGE } from "../routes/register-settings-sync-helpers.js";
import * as core from "@fusion/core";

vi.mock("../routes/register-settings-sync-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../routes/register-settings-sync-helpers.js")>("../routes/register-settings-sync-helpers.js");
  return { ...actual, fetchFromRemoteNode: vi.fn() };
});

type AppFixture = { root: string; store: TaskStore; app: ReturnType<typeof createServer>; globalDir: string; secretsStore: SecretsStore };

async function createFixture(prefix: string): Promise<AppFixture> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const globalDir = join(root, ".fusion-global-settings");
  const store = new TaskStore(root, globalDir, { inMemoryDb: true });
  await store.init();
  const central = new CentralCore(store.getFusionDir());
  await central.init();
  const centralDb = (central as unknown as { db: any | null }).db;
  if (!centralDb) throw new Error("central db unavailable");
  const mk = new MasterKeyManager({ globalDir });
  const secretsStore = new SecretsStore(store.getDatabase(), centralDb, () => mk.getOrCreateKey());
  (store as unknown as { getSecretsStore: () => Promise<SecretsStore> }).getSecretsStore = async () => secretsStore;
  return { root, store, app: createServer(store as any), globalDir, secretsStore };
}

describe("routes secrets sync", () => {
  const remoteNode = { id: "node-remote-001", type: "remote", url: "http://remote.test", apiKey: "rk" };
  const localNode = { id: "node-local-001", type: "local", apiKey: "local-key" };
  let fixture: AppFixture;
  let secrets: Awaited<ReturnType<TaskStore["getSecretsStore"]>>;
  const mockedFetchFromRemoteNode = vi.mocked(helpers.fetchFromRemoteNode);
  const logSink: string[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    fixture = await createFixture("fn-secrets-sync-");
    secrets = fixture.secretsStore;

    vi.spyOn(CentralCore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(CentralCore.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(CentralCore.prototype, "getNode").mockResolvedValue(remoteNode as any);
    vi.spyOn(CentralCore.prototype, "listNodes").mockResolvedValue([localNode as any]);
    vi.spyOn(CentralCore.prototype, "getLocalPeerInfo").mockResolvedValue({ nodeId: localNode.id, nodeName: "Local" } as any);
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logSink.push(args.map((x) => String(x)).join(" "));
    });
  });

  afterEach(async () => {
    rmSync(fixture.root, { recursive: true, force: true });
    vi.restoreAllMocks();
    logSink.length = 0;
  });

  it("POST /api/nodes/:id/secrets/push happy path", async () => {
    await setSyncPassphrase(secrets, "shared-pass");
    await secrets.createSecret({ scope: "project", key: "P_ONE", plaintextValue: "v1" });
    await secrets.createSecret({ scope: "global", key: "G_ONE", plaintextValue: "v2" });
    mockedFetchFromRemoteNode.mockResolvedValue({ success: true } as any);

    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" }, undefined);
    expect(res.status).toBe(200);
    expect((res.body as any).pushedCount).toBe(2);
    expect(mockedFetchFromRemoteNode).toHaveBeenCalledOnce();
    const body = (mockedFetchFromRemoteNode.mock.calls[0]?.[2] as any).body;
    expect(body.version).toBe(1);
    expect(body.kdf).toBe("scrypt");
    expect(body.ciphertext).toEqual(expect.any(String));
    expect(body.salt).toEqual(expect.any(String));
    expect(body.nonce).toEqual(expect.any(String));
    const unwrapped = await unwrapSecretsBundle(body, "shared-pass");
    expect(unwrapped.map((r) => r.key).sort()).toEqual(["G_ONE", "P_ONE"]);
    expect(unwrapped.map((r) => r.key)).not.toContain(RESERVED_SYNC_PASSPHRASE_KEY);
    expect(JSON.stringify(res.body)).not.toContain("shared-pass");
    expect(JSON.stringify(res.body)).not.toContain("v1");
  });

  it("POST /api/nodes/:id/secrets/push returns passphrase-not-configured", async () => {
    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("passphrase-not-configured");
  });

  it("POST /api/nodes/:id/secrets/push rejects local node", async () => {
    vi.spyOn(CentralCore.prototype, "getNode").mockResolvedValue({ ...localNode } as any);
    const res = await request(fixture.app, "POST", "/api/nodes/node-local-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["null", null],
  ])("POST /api/nodes/:id/secrets/push rejects missing remote apiKey (%s)", async (_shape, apiKey) => {
    vi.spyOn(CentralCore.prototype, "getNode").mockResolvedValue({ ...remoteNode, url: "http://remote.test", apiKey: apiKey as string } as any);

    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" });

    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
    expect(mockedFetchFromRemoteNode).not.toHaveBeenCalled();
    expect(/(forbidden-pass|forbidden-value|"salt"\s*:|"nonce"\s*:|"ciphertext"\s*:)/.test(JSON.stringify(res.body))).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["null", null],
  ])("POST /api/nodes/:id/secrets/pull rejects missing remote apiKey (%s)", async (_shape, apiKey) => {
    vi.spyOn(CentralCore.prototype, "getNode").mockResolvedValue({ ...remoteNode, url: "http://remote.test", apiKey: apiKey as string } as any);

    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/pull", JSON.stringify({}), { "content-type": "application/json" });

    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
    expect(mockedFetchFromRemoteNode).not.toHaveBeenCalled();
    expect(/(forbidden-pass|forbidden-value|"salt"\s*:|"nonce"\s*:|"ciphertext"\s*:)/.test(JSON.stringify(res.body))).toBe(false);
  });

  it("POST /api/nodes/:id/secrets/pull happy path and skip reserved", async () => {
    await setSyncPassphrase(secrets, "shared-pass");
    await secrets.createSecret({ scope: "project", key: "EXISTING", plaintextValue: "old" });
    const envelope = await wrapSecretsBundle([
      { key: "EXISTING", value: "new", scope: "project", accessPolicy: "prompt", envExportable: false },
      { key: "NEW_GLOBAL", value: "g", scope: "global", accessPolicy: "prompt", envExportable: false },
      { key: RESERVED_SYNC_PASSPHRASE_KEY, value: "nope", scope: "global", accessPolicy: "deny", envExportable: false },
    ], "shared-pass");
    mockedFetchFromRemoteNode.mockResolvedValue(envelope as any);

    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/pull", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((res.body as any).appliedCount).toBe(2);
    expect((res.body as any).skippedCount).toBe(1);
    expect((await secrets.revealSecret(secrets.listSecrets("project").find((r) => r.key === "EXISTING")!.id, "project", { agentId: null, userId: null })).plaintextValue).toBe("new");
  });

  it.each([
    ["/api/nodes/node-remote-001/secrets/push"],
    ["/api/nodes/node-remote-001/secrets/pull"],
  ])("apiKey guard fires before passphrase lookup for %s", async (path) => {
    vi.spyOn(CentralCore.prototype, "getNode").mockResolvedValue({ ...remoteNode, url: "http://remote.test", apiKey: "" } as any);

    const res = await request(fixture.app, "POST", path, JSON.stringify({}), { "content-type": "application/json" });

    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
    expect((res.body as any).error).not.toBe("passphrase-not-configured");
    expect(mockedFetchFromRemoteNode).not.toHaveBeenCalled();
  });

  it("POST /api/nodes/:id/secrets/pull wrong passphrase", async () => {
    await setSyncPassphrase(secrets, "local");
    mockedFetchFromRemoteNode.mockResolvedValue(await wrapSecretsBundle([{ key: "K", value: "V", scope: "project", accessPolicy: "prompt", envExportable: false }], "remote") as any);
    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/pull", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("wrong-passphrase");
  });

  it("POST /api/secrets/sync-receive 401 variants and no token echo", async () => {
    await setSyncPassphrase(secrets, "shared-pass");
    const payload = { sourceNodeId: "node-x", exportedAt: new Date().toISOString(), version: 1, ciphertext: "a", salt: "b", nonce: "c", kdf: "scrypt", kdfParams: { N: 32768, r: 8, p: 1, keyLen: 32 } };
    for (const headers of [{}, { Authorization: "Bearer " }, { Authorization: "Bearer wrong" }]) {
      const res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify(payload), { "content-type": "application/json", ...(headers as any) });
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("wrong");
    }
    vi.spyOn(CentralCore.prototype, "listNodes").mockResolvedValue([{ ...localNode, apiKey: "" } as any]);
    const res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify(payload), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(401);
  });

  it("POST /api/secrets/sync-receive version mismatch before unwrap", async () => {
    await setSyncPassphrase(secrets, "shared-pass");
    const spy = vi.spyOn(core, "unwrapSecretsBundle");
    const res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify({ sourceNodeId: "node-x", exportedAt: new Date().toISOString(), version: 2, ciphertext: "a", salt: "b", nonce: "c", kdf: "scrypt", kdfParams: { N: 32768, r: 8, p: 1, keyLen: 32 } }), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("version-mismatch");
    expect(spy).not.toHaveBeenCalled();
  });

  it("POST /api/secrets/sync-receive passphrase-not-configured", async () => {
    const envelope = await wrapSecretsBundle([], "shared-pass");
    const res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify({ ...envelope, sourceNodeId: "node-x", exportedAt: new Date().toISOString() }), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("passphrase-not-configured");
  });

  it("POST /api/secrets/sync-receive wrong-passphrase and malformed", async () => {
    await setSyncPassphrase(secrets, "local");
    const wrong = await wrapSecretsBundle([{ key: "A", value: "B", scope: "project", accessPolicy: "prompt", envExportable: false }], "remote");
    let res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify({ ...wrong, sourceNodeId: "node-x", exportedAt: new Date().toISOString() }), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("wrong-passphrase");

    res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify({ ...wrong, ciphertext: "***", sourceNodeId: "node-x", exportedAt: new Date().toISOString() }), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("malformed");
  });

  it("POST /api/secrets/sync-receive roundtrip persists re-encrypted values", async () => {
    await setSyncPassphrase(secrets, "shared");
    const envelope = await wrapSecretsBundle([{ key: "R1", value: "VALUE1", scope: "project", accessPolicy: "prompt", envExportable: false }], "shared");

    const res = await request(fixture.app, "POST", "/api/secrets/sync-receive", JSON.stringify({ ...envelope, sourceNodeId: "sender", exportedAt: new Date().toISOString() }), { "content-type": "application/json", Authorization: "Bearer local-key" });
    expect(res.status).toBe(200);
    const receiverRow = secrets.listSecrets("project").find((r) => r.key === "R1")!;
    const receiverCipher = (fixture.store.getDatabase().prepare("SELECT value_ciphertext FROM secrets WHERE id=?").get(receiverRow.id) as { value_ciphertext: string }).value_ciphertext;
    expect(receiverCipher).toBeTruthy();
    expect(receiverCipher).not.toBe(envelope.ciphertext);
  });

  it("GET /api/secrets/sync-export happy path and auth errors", async () => {
    await setSyncPassphrase(secrets, "shared");
    await secrets.createSecret({ scope: "global", key: "K1", plaintextValue: "V1" });
    const res = await request(fixture.app, "GET", "/api/secrets/sync-export", undefined, { Authorization: "Bearer local-key" });
    expect(res.status).toBe(200);
    const records = await unwrapSecretsBundle(res.body as any, "shared");
    expect(records.map((r) => r.key)).toEqual(["K1"]);

    await secrets.deleteSecret(secrets.listSecrets("global").find((r) => r.key === RESERVED_SYNC_PASSPHRASE_KEY)!.id, "global");
    const noPassRes = await request(fixture.app, "GET", "/api/secrets/sync-export", undefined, { Authorization: "Bearer local-key" });
    expect(noPassRes.status).toBe(400);
  });

  it("GET /api/secrets/sync-export 401 variants and no token echo", async () => {
    await setSyncPassphrase(secrets, "shared-pass");

    for (const { headerValue, tokenToCheck } of [
      { headerValue: undefined, tokenToCheck: "missing-token-marker" },
      { headerValue: "Bearer ", tokenToCheck: "Bearer " },
      { headerValue: "Basic abc", tokenToCheck: "abc" },
      { headerValue: "Bearer wrong", tokenToCheck: "wrong" },
    ]) {
      const res = await request(
        fixture.app,
        "GET",
        "/api/secrets/sync-export",
        undefined,
        headerValue ? { Authorization: headerValue } : undefined,
      );
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(tokenToCheck);
    }

    vi.spyOn(CentralCore.prototype, "listNodes").mockResolvedValue([{ ...localNode, apiKey: "" } as any]);
    const emptyApiKeyRes = await request(fixture.app, "GET", "/api/secrets/sync-export", undefined, { Authorization: "Bearer local-key" });
    expect(emptyApiKeyRes.status).toBe(401);
    expect(JSON.stringify(emptyApiKeyRes.body)).not.toContain("local-key");
  });

  it("push->receive end-to-end preserves plaintext and avoids reserved key in payload", async () => {
    await setSyncPassphrase(secrets, "shared");
    await secrets.createSecret({ scope: "project", key: "A", plaintextValue: "1" });
    await secrets.createSecret({ scope: "global", key: "B", plaintextValue: "2" });

    mockedFetchFromRemoteNode.mockResolvedValue({ success: true } as any);
    const pushRes = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" });
    expect(pushRes.status).toBe(200);

    const body = (mockedFetchFromRemoteNode.mock.calls.at(-1)?.[2] as any).body;
    const unwrapped = await unwrapSecretsBundle(body, "shared");
    expect(unwrapped.find((record) => record.key === RESERVED_SYNC_PASSPHRASE_KEY)).toBeUndefined();
    expect(unwrapped.map((record) => record.value).sort()).toEqual(["1", "2"]);
  });

  it("audit and responses never expose passphrase, envelope material, or plaintext", async () => {
    await setSyncPassphrase(secrets, "forbidden-pass");
    await secrets.createSecret({ scope: "project", key: "NO_LEAK", plaintextValue: "forbidden-value" });
    mockedFetchFromRemoteNode.mockResolvedValue({ success: true } as any);
    const res = await request(fixture.app, "POST", "/api/nodes/node-remote-001/secrets/push", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);

    const forbidden = /(forbidden-pass|forbidden-value|"salt"\s*:|"nonce"\s*:|"ciphertext"\s*:)/;
    expect(forbidden.test(JSON.stringify(res.body))).toBe(false);
    expect(forbidden.test(logSink.join("\n"))).toBe(false);
  });
});
