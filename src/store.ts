/**
 * The answers this plugin keeps on this computer.
 *
 * Nothing reaches the database: a kept answer lives in the plugin's own folder,
 * named after the entry that made it, so a second press reads it back instead
 * of asking Instagram again. The price of staying out of the database is that
 * the archive cannot search the text and no other computer holds a copy.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** An entry id is a UUID, and nothing else may become a file name. */
const ENTRY = /^[A-Za-z0-9_-]{1,64}$/;

/** A data kind this plugin may keep, in the shape a file name needs. */
const KIND = /^[a-z][a-z0-9-]{0,31}$/;

/** The helper keeps no more than this from one answer. */
const MAX_TEXT = 200_000;

const FOLDER = "saved";

export type Saved = { text: string; savedAt: number };

function pathOf(
  root: string,
  entryId: string,
  kind: string,
): string | null {
  if (!ENTRY.test(entryId) || !KIND.test(kind)) {
    return null;
  }
  return join(root, FOLDER, `${entryId}.${kind}.json`);
}

/**
 * The answer kept for an entry, when it is young enough to still be one. A
 * maximum age of zero keeps it until the plugin's own data is removed.
 */
export async function savedAnswer(input: {
  root: string;
  entryId: string;
  kind: string;
  maxAgeMs: number;
}): Promise<Saved | null> {
  const path = pathOf(input.root, input.entryId, input.kind);
  if (!path) {
    return null;
  }

  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const savedAt =
      typeof record.savedAt === "number" && Number.isFinite(record.savedAt)
        ? record.savedAt
        : 0;
    if (!text || savedAt <= 0) {
      return null;
    }
    if (input.maxAgeMs > 0 && Date.now() - savedAt > input.maxAgeMs) {
      return null;
    }
    return { text, savedAt };
  } catch {
    return null;
  }
}

/**
 * Writes the answer down, so the next press reads it instead of asking. A
 * failure is not an error the reader should see: the answer itself is already
 * in hand.
 */
export async function saveAnswer(input: {
  root: string;
  entryId: string;
  kind: string;
  text: string;
}): Promise<boolean> {
  const path = pathOf(input.root, input.entryId, input.kind);
  if (!path || !input.text.trim()) {
    return false;
  }

  try {
    await mkdir(join(input.root, FOLDER), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        { text: input.text.slice(0, MAX_TEXT), savedAt: Date.now() },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}
