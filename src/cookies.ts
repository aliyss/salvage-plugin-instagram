/**
 * Where a session comes from. Two ways are supported, because a pasted cookie
 * is easy to cut short:
 *
 * - a value pasted into the plugin's settings, which may be the `sessionid`
 *   value alone or the browser's whole cookie header;
 * - a cookie file this computer already holds, written by a browser extension
 *   that exports the Netscape `cookies.txt` format.
 *
 * Instagram signs a session with `sessionid`; some routes also read
 * `csrftoken`, so both are carried when they are offered.
 */

import { readFile } from "node:fs/promises";

import { PluginError } from "./sdk";

/** What this computer sends Instagram as one signed-in reader. */
export type Session = { cookie: string; csrf: string | null };

/**
 * The cookies a signed-in browser holds that this plugin may send. Nothing
 * else is kept: neither a pasted header nor a cookie file can add a cookie
 * this list does not name.
 */
const COOKIE_NAMES = [
  "sessionid",
  "csrftoken",
  "ds_user_id",
  "mid",
  "ig_did",
  "rur",
];

/** A cookie value, so it may hold nothing that ends a header. */
const COOKIE_VALUE = /^[A-Za-z0-9%:._-]{1,300}$/;

/** A host Instagram sets a cookie on, with or without a leading dot. */
const INSTAGRAM_HOST = /(^|\.)instagram\.com$/i;

/** The fields of one cookies.txt row, which is tab separated. */
const JAR_FIELDS = 7;

function sessionOfPairs(pairs: Map<string, string>): Session {
  return {
    cookie: [...pairs].map(([name, value]) => `${name}=${value}`).join("; "),
    csrf: pairs.get("csrftoken") ?? null,
  };
}

/**
 * The session a pasted value names: the `sessionid` value on its own, or the
 * whole cookie header a browser shows. The header is preferred when both are
 * offered, because it carries `csrftoken` with it.
 */
export function parseSessionValue(raw: string | undefined): Session | null {
  const pasted = (raw ?? "").trim();
  if (!pasted) {
    return null;
  }

  const pairs = new Map<string, string>();
  if (pasted.includes("=")) {
    for (const part of pasted.split(";")) {
      const at = part.indexOf("=");
      if (at < 0) {
        continue;
      }
      const name = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (!COOKIE_NAMES.includes(name) || !COOKIE_VALUE.test(value)) {
        continue;
      }
      pairs.set(name, value);
    }
  } else if (COOKIE_VALUE.test(pasted)) {
    pairs.set("sessionid", pasted);
  }

  return pairs.get("sessionid") ? sessionOfPairs(pairs) : null;
}

/**
 * The Instagram cookies a `cookies.txt` file holds. The format is Netscape's:
 * `domain`, a subdomain flag, `path`, a secure flag, an expiry, the name, and
 * the value, all tab separated. Comment lines and other hosts are skipped.
 */
export function readCookieFile(raw: string): Session | null {
  const pairs = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith("#")) {
      continue;
    }

    const fields = row.split("\t");
    if (fields.length < JAR_FIELDS) {
      continue;
    }
    const domain = fields[0].replace(/^\./, "").trim();
    const name = fields[5].trim();
    const value = fields.slice(6).join("\t").trim();
    if (
      !INSTAGRAM_HOST.test(domain) ||
      !COOKIE_NAMES.includes(name) ||
      !COOKIE_VALUE.test(value)
    ) {
      continue;
    }
    pairs.set(name, value);
  }

  return pairs.get("sessionid") ? sessionOfPairs(pairs) : null;
}

/** The session one file holds, or null when it cannot be read. */
export async function sessionFromFile(path: string): Promise<Session | null> {
  try {
    return readCookieFile(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The session to use: the value pasted into the settings, or the cookie file
 * named there, or a refusal that says which of the two was tried.
 */
export async function resolveSession(input: {
  secret: string | undefined;
  file: string | undefined;
}): Promise<Session> {
  const pasted = parseSessionValue(input.secret);
  if (pasted) {
    return pasted;
  }

  const file = (input.file ?? "").trim();
  if (file) {
    const saved = await sessionFromFile(file);
    if (saved) {
      return saved;
    }
    throw new PluginError(
      "refused",
      `The cookie file ${file} holds no Instagram session. Export the cookies of instagram.com again, or paste the sessionid value instead.`,
    );
  }

  throw new PluginError(
    "refused",
    "This plugin needs an Instagram session. Paste the sessionid cookie on the plugin's own page, or name a cookies.txt file exported from a browser on this computer.",
  );
}
