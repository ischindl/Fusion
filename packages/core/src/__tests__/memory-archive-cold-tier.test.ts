/**
 * RUFU-665: the cold tier must be enumerated, listed, and readable — and must stay unwritable.
 *
 * Budget maintenance MOVES an over-budget `MEMORY.md`'s oldest `## ` sections verbatim into
 * `ARCHIVE-YYYY-MM-DD.md` beside the hot file. A move whose destination is unreachable is a deletion
 * wearing different words, so every read lane that served `MEMORY.md` has to serve the archive too, and
 * the write lanes must not gain the archive as a target, or the append-only record the loss-proof rests
 * on can be rewritten by any caller holding a path.
 *
 * Each case below therefore asserts one of the two halves of that contract, through the production
 * seams (`listProjectMemoryFiles`, `readProjectMemoryFile`, `writeProjectMemoryFile`, the agent-scope
 * pair, the file-lane scorer, and the disk-fallback allowlist) rather than against the predicate alone.
 *
 * FNXC:MemoryBudget 2026-11-20-11:55 (RUFU-665).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryBackendError,
  listProjectMemoryFiles,
  listAgentMemoryFiles,
  readProjectMemoryFile,
  readProjectMemoryFileContent,
  writeProjectMemoryFile,
  readAgentMemoryFile,
  writeAgentMemoryFile,
  searchMemoryFiles,
} from "../memory/memory-backend.js";
import { isCanonicalLayeredMemoryPath } from "../memory/project-memory.js";
import {
  MEMORY_ARCHIVE_FILENAME_PREFIX,
  MEMORY_ARCHIVE_PREAMBLE,
  archiveMemoryFileName,
  isArchiveMemoryFileName,
} from "../memory/memory-archive-filename.js";

const ARCHIVE_NAME = "ARCHIVE-2026-09-30.md";
const AGENT_ID = "agent-cold-tier";

/** One retired section, exactly as the roll-up writes it: heading plus body, verbatim. */
const RETIRED_SECTION = [
  "## Lockfile drift in plugin workspaces",
  "- regenerate `pnpm-lock.yaml` inside the workspace, never by hand",
  "- the gate fails on the hash, so a hand edit survives review and dies at merge",
  "",
].join("\n");

let rootDir = "";

function memoryDir(): string {
  return join(rootDir, ".fusion", "memory");
}

function agentMemoryDir(): string {
  return join(rootDir, ".fusion", "agent-memory", AGENT_ID);
}

async function writeProjectArchive(content: string, dir = memoryDir()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, ARCHIVE_NAME);
  writeFileSync(path, content, "utf-8");
  return path;
}

function archiveBody(): string {
  return `${MEMORY_ARCHIVE_PREAMBLE}${RETIRED_SECTION}`;
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "rufu-665-"));
  await mkdir(memoryDir(), { recursive: true });
  await mkdir(agentMemoryDir(), { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("cold tier: the filename contract is one authority", () => {
  it("the builder produces the shape the predicate accepts, and only that shape", () => {
    const produced = archiveMemoryFileName(new Date(Date.UTC(2026, 8, 30)));
    expect(produced).toBe(ARCHIVE_NAME);
    expect(produced.startsWith(MEMORY_ARCHIVE_FILENAME_PREFIX)).toBe(true);
    expect(isArchiveMemoryFileName(produced)).toBe(true);
  });

  it("a shape no writer could produce is refused, including a calendar-impossible date", () => {
    // Anchoring and component width are what keep a read path from naming files nothing wrote.
    for (const rejected of [
      "ARCHIVE-2026-9-30.md",
      "ARCHIVE-2026-09-30.markdown",
      "ARCHIVE-2026-13-99.md",
      "ARCHIVE-2026-02-30.md",
      "MEMORY.md",
      "archive-2026-09-30.md",
      "sub/ARCHIVE-2026-09-30.md",
      "../ARCHIVE-2026-09-30.md",
      "",
    ]) {
      expect(isArchiveMemoryFileName(rejected), rejected).toBe(false);
    }
  });
});

describe("cold tier: project scope is listed, readable, and never writable", () => {
  it("lists the archive beside the hot file, labelled as archived long-term memory", async () => {
    writeFileSync(join(memoryDir(), "MEMORY.md"), "# Project Memory\n\n## Live\n- still hot\n", "utf-8");
    await writeProjectArchive(archiveBody());

    const files = await listProjectMemoryFiles(rootDir);
    const archive = files.find((file) => file.path === `.fusion/memory/${ARCHIVE_NAME}`);

    expect(archive, "a retired note absent from the listing is a deleted note").toBeDefined();
    // The layer union stays closed: an archive IS retired long-term content, so it reports the layer
    // the content came from and the label carries the distinction.
    expect(archive?.layer).toBe("long-term");
    expect(archive?.label).toBe("Archived long-term memory");
  });

  it("does not list a stray file in the memory directory just because it ends in .md", async () => {
    writeFileSync(join(memoryDir(), "SCRATCH-NOTES.md"), "## not memory\n", "utf-8");
    const files = await listProjectMemoryFiles(rootDir);
    expect(files.some((file) => file.path.includes("SCRATCH-NOTES.md"))).toBe(false);
  });

  it("reads the retired section back verbatim through the get seam", async () => {
    await writeProjectArchive(archiveBody());
    const result = await readProjectMemoryFile(rootDir, { path: `.fusion/memory/${ARCHIVE_NAME}` });

    expect(result.path).toBe(`.fusion/memory/${ARCHIVE_NAME}`);
    expect(result.content).toContain("## Lockfile drift in plugin workspaces");
    expect(result.content).toContain("the gate fails on the hash");
  });

  it("reads it back verbatim through the content seam too, byte for byte", async () => {
    const expected = archiveBody();
    await writeProjectArchive(expected);
    const { content } = await readProjectMemoryFileContent(rootDir, `.fusion/memory/${ARCHIVE_NAME}`);
    expect(content).toBe(expected);
  });

  it("refuses a WRITE to the cold tier, and names the read-only allowance while doing it", async () => {
    await writeProjectArchive(archiveBody());
    const before = readFileSyncSafe(join(memoryDir(), ARCHIVE_NAME));

    const error = await writeProjectMemoryFile(rootDir, `.fusion/memory/${ARCHIVE_NAME}`, "# overwritten\n")
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MemoryBackendError);
    expect((error as MemoryBackendError).code).toBe("UNSUPPORTED");
    expect((error as Error).message).toContain("read-only cold tier");
    // The refusal must be a refusal, not a partial write.
    expect(readFileSyncSafe(join(memoryDir(), ARCHIVE_NAME))).toBe(before);
  });

  it("refuses a calendar-impossible archive path instead of serving it", async () => {
    const error = await readProjectMemoryFile(rootDir, { path: ".fusion/memory/ARCHIVE-2026-13-99.md" })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MemoryBackendError);
  });

  it("keeps traversal out, as it always did", async () => {
    const error = await readProjectMemoryFile(rootDir, { path: `.fusion/memory/../${ARCHIVE_NAME}` })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MemoryBackendError);
  });

  it("counts the archive as a search hit in the file lane, which is what makes 'still searchable' true", async () => {
    writeFileSync(join(memoryDir(), "MEMORY.md"), "# Project Memory\n\n## Live\n- nothing about lockfiles here\n", "utf-8");
    await writeProjectArchive(archiveBody());

    const hits = await searchMemoryFiles(rootDir, { query: "lockfile drift workspace", limit: 5 }, "file");

    expect(hits.some((hit) => hit.path === `.fusion/memory/${ARCHIVE_NAME}`), "a retired note that cannot be found by search is a retired note that is gone").toBe(true);
  });

  it("accepts the archive as a canonical layered path, so the disk fallback can serve it", () => {
    expect(isCanonicalLayeredMemoryPath(`.fusion/memory/${ARCHIVE_NAME}`)).toBe(true);
    expect(isCanonicalLayeredMemoryPath(".fusion/memory/MEMORY.md")).toBe(true);
    expect(isCanonicalLayeredMemoryPath(".fusion/memory/2026-09-30.md")).toBe(true);
    expect(isCanonicalLayeredMemoryPath(".fusion/memory/SCRATCH.md")).toBe(false);
    expect(isCanonicalLayeredMemoryPath(".fusion/memory/ARCHIVE-2026-13-99.md")).toBe(false);
  });
});

describe("cold tier: agent scope is readable and never writable", () => {
  it("lists and reads an agent's own archive", async () => {
    writeFileSync(join(agentMemoryDir(), "MEMORY.md"), "# Agent Memory\n\n## Live\n- hot\n", "utf-8");
    await writeProjectArchive(archiveBody(), agentMemoryDir());

    const files = await listAgentMemoryFiles(rootDir, AGENT_ID);
    expect(files.some((file) => file.path.endsWith(ARCHIVE_NAME))).toBe(true);

    const read = await readAgentMemoryFile(rootDir, AGENT_ID, `.fusion/agent-memory/${AGENT_ID}/${ARCHIVE_NAME}`);
    expect(read.content).toContain("## Lockfile drift in plugin workspaces");
  });

  it("refuses an agent-scope WRITE to its archive", async () => {
    await writeProjectArchive(archiveBody(), agentMemoryDir());
    const error = await writeAgentMemoryFile(rootDir, AGENT_ID, `.fusion/agent-memory/${AGENT_ID}/${ARCHIVE_NAME}`, "x")
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MemoryBackendError);
    expect((error as Error).message).toContain("read-only cold tier");
  });
});

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
