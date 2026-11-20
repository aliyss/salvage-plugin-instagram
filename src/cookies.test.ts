import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSessionValue,
  readCookieFile,
  resolveSession,
  sessionFromFile,
} from "./cookies";

const JAR = [
  "# Netscape HTTP Cookie File",
  ".instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\t258%3Aabc",
  ".instagram.com\tTRUE\t/\tTRUE\t1893456000\tcsrftoken\ttoken123",
  ".instagram.com\tTRUE\t/\tTRUE\t1893456000\tevil\tdrop",
  ".example.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tother",
  "",
].join("\n");

describe("parseSessionValue", () => {
  it("takes the sessionid value on its own", () => {
    expect(parseSessionValue("2582778888%3ASLrICY64qw5Op3")).toEqual({
      cookie: "sessionid=2582778888%3ASLrICY64qw5Op3",
      csrf: null,
    });
  });

  it("takes a browser's cookie header, and drops what it may not send", () => {
    const session = parseSessionValue(
      "csrftoken=abc123; evil=drop; sessionid=258%3Axyz; ds_user_id=42",
    );

    expect(session?.cookie).toBe(
      "csrftoken=abc123; sessionid=258%3Axyz; ds_user_id=42",
    );
    expect(session?.csrf).toBe("abc123");
  });

  it("answers nothing for a value with no session, or that cannot be a header", () => {
    expect(parseSessionValue("")).toBeNull();
    expect(parseSessionValue(undefined)).toBeNull();
    expect(parseSessionValue("csrftoken=abc")).toBeNull();
    expect(parseSessionValue("sessionid=abc\r\nX-Evil: 1")).toBeNull();
  });
});

describe("readCookieFile", () => {
  it("reads the Instagram cookies and leaves the rest", () => {
    const session = readCookieFile(JAR);

    expect(session?.cookie).toBe(
      "sessionid=258%3Aabc; csrftoken=token123",
    );
    expect(session?.csrf).toBe("token123");
  });

  it("answers nothing for a file of another site", () => {
    expect(
      readCookieFile(
        ".example.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tother",
      ),
    ).toBeNull();
    expect(readCookieFile("")).toBeNull();
  });
});

describe("resolveSession", () => {
  it("prefers the pasted value over the file", async () => {
    const session = await resolveSession({
      secret: "258%3Apasted",
      file: "/nowhere/cookies.txt",
    });
    expect(session.cookie).toBe("sessionid=258%3Apasted");
  });

  it("falls back to the file it is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "salvage-cookies-"));
    const path = join(root, "cookies.txt");
    await writeFile(path, JAR);

    const session = await sessionFromFile(path);
    expect(session?.cookie).toContain("sessionid=258%3Aabc");

    expect(
      (await resolveSession({ secret: "", file: path })).cookie,
    ).toContain("csrftoken=token123");
  });

  it("says which of the two was looked for", async () => {
    await expect(resolveSession({ secret: "", file: "" })).rejects.toThrow(
      /Paste the sessionid cookie/,
    );
    await expect(
      resolveSession({ secret: "", file: "/nowhere/cookies.txt" }),
    ).rejects.toThrow("holds no Instagram session");
  });
});
