import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runCursorCommand: vi.fn() }));

import { runCursorCommand } from "../cli-spawn.js";
import { probeCursorBinary } from "../probe.js";

describe("probeCursorBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports available when probe succeeds", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 0, stdout: "1.2.3", stderr: "" });
    const result = await probeCursorBinary({ binaryPath: "/usr/local/bin/cursor-agent" });
    expect(runCursorCommand).toHaveBeenCalledWith("/usr/local/bin/cursor-agent", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.binaryPath).toBe("/usr/local/bin/cursor-agent");
    expect(result.configuredBinaryPath).toBe("/usr/local/bin/cursor-agent");
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });

  it("reports keychain lock as auth failure", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "Error: Your macOS login keychain is locked." });
    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("keychain");
  });

  it("reports ide-not-installed as unavailable auth state", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "Error: No Cursor IDE installation found." });
    const result = await probeCursorBinary({ binaryPath: "cursor" });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("installation not found");
  });

  it("probes cursor-agent before cursor and reports the first Windows shim success", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "cursor-agent 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      available: true,
      authenticated: true,
      binaryName: "cursor-agent",
      binaryPath: "cursor-agent",
      version: "cursor-agent 0.50.0",
    });
  });

  it("falls back to cursor when cursor-agent fails but cursor succeeds", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.binaryName).toBe("cursor");
    expect(result.version).toBe("cursor 0.50.0");
  });

  it("reports binary unavailable with actionable diagnostics when all candidates fail", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent.cmd" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor.cmd" });

    const result = await probeCursorBinary();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.reason).toContain("cursor-agent: spawn error: ENOENT");
    expect(result.reason).toContain("cursor: spawn error: ENOENT");
  });

  it("tries a Windows path with spaces and .cmd shim before PATH fallback", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "cursor-agent.cmd 0.50.0", stderr: "" });

    const binaryPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd";
    const result = await probeCursorBinary({ binaryPath });

    expect(runCursorCommand).toHaveBeenCalledWith(binaryPath, ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenCalledTimes(1);
    expect(result.binaryPath).toBe(binaryPath);
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });

  it("falls back to PATH candidates when a configured binary fails", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: /missing/cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor-agent 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary({ binaryPath: "/missing/cursor-agent" });

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "/missing/cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor-agent", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.binaryPath).toBe("cursor-agent");
    expect(result.usingConfiguredBinaryPath).toBe(false);
    expect(result.diagnostics?.[0]).toContain("/missing/cursor-agent: spawn error: ENOENT");
  });

  it("reports configured-path and fallback diagnostics when every candidate fails", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 126, stdout: "", stderr: "spawn error: EACCES: /opt/Cursor/cursor-agent" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor" });

    const result = await probeCursorBinary({ binaryPath: "/opt/Cursor/cursor-agent" });

    expect(result.available).toBe(false);
    expect(result.reason).toContain("Configured Cursor CLI binary '/opt/Cursor/cursor-agent' failed");
    expect(result.reason).toContain("/opt/Cursor/cursor-agent: spawn error: EACCES");
    expect(result.reason).toContain("cursor-agent: spawn error: ENOENT");
    expect(result.reason).toContain("cursor: spawn error: ENOENT");
  });

  it("dedupes overrides equal to default PATH candidate names", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary({ binaryPath: " cursor-agent " });

    expect(runCursorCommand).toHaveBeenCalledTimes(2);
    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor", ["--version"], 3000);
    expect(result.binaryPath).toBe("cursor");
  });
});
