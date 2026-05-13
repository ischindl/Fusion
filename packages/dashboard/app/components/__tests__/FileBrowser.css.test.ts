import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("FileBrowser.css token contract", () => {
  it("does not use deprecated --radius alias token", async () => {
    const css = await readFile("app/components/FileBrowser.css", "utf8");
    expect(css).not.toMatch(/var\(--radius\)/);
  });
});
