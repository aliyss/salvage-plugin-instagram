import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { savedAnswer, saveAnswer } from "./store";

const ENTRY = "7b8f4c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b";
const KIND = "instagram-comments";

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "salvage-instagram-"));
}

describe("saveAnswer and savedAnswer", () => {
  it("reads back what was kept", async () => {
    const folder = await root();
    expect(
      await saveAnswer({ root: folder, entryId: ENTRY, kind: KIND, text: "hi" }),
    ).toBe(true);

    const saved = await savedAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      maxAgeMs: 60_000,
    });
    expect(saved?.text).toBe("hi");
    expect(saved?.savedAt).toBeGreaterThan(0);
  });

  it("writes the answer where the plugin's folder holds it", async () => {
    const folder = await root();
    await saveAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      text: "hello",
    });

    const written = JSON.parse(
      await readFile(join(folder, "saved", `${ENTRY}.${KIND}.json`), "utf8"),
    ) as { text: string };
    expect(written.text).toBe("hello");
  });

  it("leaves an answer out once it is older than the keep time", async () => {
    const folder = await root();
    await saveAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      text: "stale",
    });

    const path = join(folder, "saved", `${ENTRY}.${KIND}.json`);
    await writeFile(
      path,
      JSON.stringify({ text: "stale", savedAt: Date.now() - 8 * 24 * 3600_000 }),
    );

    expect(
      await savedAnswer({
        root: folder,
        entryId: ENTRY,
        kind: KIND,
        maxAgeMs: 7 * 24 * 3600_000,
      }),
    ).toBeNull();
  });

  it("keeps an answer for ever when the time is zero", async () => {
    const folder = await root();
    const path = join(folder, "saved", `${ENTRY}.${KIND}.json`);
    await saveAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      text: "old",
    });
    await writeFile(
      path,
      JSON.stringify({ text: "old", savedAt: Date.now() - 400 * 24 * 3600_000 }),
    );

    const saved = await savedAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      maxAgeMs: 0,
    });
    expect(saved?.text).toBe("old");
  });

  it("answers nothing for an entry that never asked, or for a bad name", async () => {
    const folder = await root();
    expect(
      await savedAnswer({
        root: folder,
        entryId: ENTRY,
        kind: KIND,
        maxAgeMs: 0,
      }),
    ).toBeNull();
    expect(
      await savedAnswer({
        root: folder,
        entryId: "../escape",
        kind: KIND,
        maxAgeMs: 0,
      }),
    ).toBeNull();
    expect(
      await saveAnswer({
        root: folder,
        entryId: "../escape",
        kind: KIND,
        text: "no",
      }),
    ).toBe(false);
  });

  it("trims an answer longer than the helper keeps", async () => {
    const folder = await root();
    await saveAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      text: "x".repeat(210_000),
    });

    const saved = await savedAnswer({
      root: folder,
      entryId: ENTRY,
      kind: KIND,
      maxAgeMs: 0,
    });
    expect(saved?.text.length).toBe(200_000);
  });
});
