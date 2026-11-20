/**
 * Reads one Instagram post with a browser session the user pasted into this
 * plugin's own settings.
 *
 * Instagram has no public API for a post someone else made, so this uses the
 * same private web endpoints the page itself calls. That is why the session
 * lives on the helper and never travels to the web app: the request leaves this
 * computer as the signed-in user, and no token reaches a server.
 *
 * Nothing here touches a vault: the text is handed back to the browser, which
 * decides what to do with it.
 */

import { type Session } from "./cookies";
import { PluginError } from "./sdk";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** The web application's own id, which every request from the site carries. */
const APP_ID = "936619743392459";

/** The host that answers the private API, then the one that sometimes does. */
const HOSTS = ["https://i.instagram.com", "https://www.instagram.com"];

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4_000_000;
const MAX_PAGES = 10;
/** A thread costs one request per comment, so replies are bounded twice. */
const MAX_REPLY_PAGES = 2;
const MAX_REPLY_REQUESTS = 25;
const REPLY_MS = 25_000;
const MAX_COMMENT_CHARS = 2_000;
const MAX_CAPTION_CHARS = 4_000;
/** The helper keeps no more than this from one answer, so the text is capped. */
const MAX_TEXT_CHARS = 200_000;

/**
 * The alphabet a post code is written in. A code is the post's id written in
 * base 64, so the id can be read back without a request.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** What a code may be made of, which is also what the id may be read from. */
const CODE = /^[A-Za-z0-9_-]{1,20}$/;

/** A code on a link is a whole post's, so it is never a single character. */
const SHORTCODE = /^[A-Za-z0-9_-]{5,20}$/;

/** The paths a post code sits behind, in the order they are looked for. */
const KIND_SEGMENTS = new Set(["p", "reel", "reels", "tv"]);


export type Comment = {
  id: string;
  handle: string;
  text: string;
  likes: number;
  replies: number;
  /** When it was written, in seconds; null when Instagram did not say. */
  at: number | null;
  /** The handle of the comment this one answers, when it answers one. */
  replyTo?: string;
};

export type Post = {
  id: string;
  code: string;
  handle: string;
  caption: string;
  comments: number;
  at: number | null;
  /** The video's own address, which a transcript has to download. */
  videoUrl: string | null;
  durationSeconds: number | null;
};

export type CommentPage = {
  comments: Comment[];
  /** The cursor the next page is read from, or null when there is no next. */
  next: string | null;
  more: boolean;
};

/** A page of the replies under one comment. */
export type ReplyPage = CommentPage;

/** The post id a code spells, or null when the code is not one. */
export function mediaIdOf(code: string): string | null {
  if (!CODE.test(code)) {
    return null;
  }

  let id = 0n;
  for (const char of code) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    id = id * 64n + BigInt(index);
  }
  return id.toString();
}

/**
 * The code of an Instagram link: `/p/`, `/reel/`, `/reels/`, `/tv/`, and the
 * same paths under a username. A profile or a story link has no post code.
 */
export function postCodeOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !/(^|\.)instagram\.com$/i.test(url.hostname) &&
    !/(^|\.)instagr\.am$/i.test(url.hostname)
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (KIND_SEGMENTS.has(segments[index])) {
      const code = segments[index + 1];
      return SHORTCODE.test(code) ? code : null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One comment, from whichever shape the answer carries it in. */
function commentOf(raw: unknown): Comment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const user = isRecord(raw.user) ? raw.user : {};
  const body = text(raw.text);
  const handle = text(user.username);
  if (!handle) {
    return null;
  }

  return {
    id: text(raw.pk) || `${handle}:${String(raw.created_at ?? "")}`,
    handle,
    text: body,
    likes: number(raw.comment_like_count),
    replies: number(raw.child_comment_count),
    at:
      typeof raw.created_at === "number" && Number.isFinite(raw.created_at)
        ? Math.round(raw.created_at)
        : null,
  };
}

/** The comments on a page, and how the next one is reached. */
export function parseComments(raw: unknown): CommentPage {
  if (!isRecord(raw)) {
    return { comments: [], next: null, more: false };
  }

  const listed = Array.isArray(raw.comments) ? raw.comments : [];
  const comments = listed.flatMap<Comment>((entry) => {
    const comment = commentOf(entry);
    return comment ? [comment] : [];
  });

  const next =
    typeof raw.next_min_id === "string" && raw.next_min_id
      ? raw.next_min_id
      : null;
  return { comments, next, more: raw.has_more_comments === true && next !== null };
}

/**
 * The replies on a page, and how the next one is reached. Instagram names the
 * cursor of a thread after the end it reads from, so both ends are accepted.
 */
export function parseReplies(raw: unknown): ReplyPage {
  if (!isRecord(raw)) {
    return { comments: [], next: null, more: false };
  }

  const listed = Array.isArray(raw.child_comments) ? raw.child_comments : [];
  const comments = listed.flatMap<Comment>((entry) => {
    const comment = commentOf(entry);
    return comment ? [comment] : [];
  });

  const next =
    typeof raw.next_max_child_cursor === "string" &&
    raw.next_max_child_cursor
      ? raw.next_max_child_cursor
      : typeof raw.next_min_child_cursor === "string" &&
          raw.next_min_child_cursor
        ? raw.next_min_child_cursor
        : null;
  const more =
    (raw.has_more_tail_child_comments === true ||
      raw.has_more_head_child_comments === true) &&
    next !== null;

  return { comments, next, more };
}

/**
 * The post an `info` answer describes. Instagram moved these fields between two
 * shapes over the years, so both are read and the older one is the fallback.
 */
export function parsePost(raw: unknown): Post | null {
  if (!isRecord(raw)) {
    return null;
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  const item = items.find(isRecord);
  if (!item) {
    return null;
  }

  const user = isRecord(item.user) ? item.user : {};
  const caption = isRecord(item.caption) ? text(item.caption.text) : "";
  const edges = isRecord(item.edge_media_to_caption)
    ? Array.isArray(item.edge_media_to_caption.edges)
      ? item.edge_media_to_caption.edges
      : []
    : [];
  const firstEdge = edges.find(isRecord);
  const legacyCaption =
    firstEdge && isRecord(firstEdge.node) ? text(firstEdge.node.text) : "";

  const versions = Array.isArray(item.video_versions)
    ? item.video_versions
    : [];
  const version = versions.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && typeof candidate.url === "string",
  );

  const code = text(item.code);
  const id = text(item.pk) || text(item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    code,
    handle: text(user.username),
    caption: caption || legacyCaption,
    comments: number(item.comment_count),
    at:
      typeof item.taken_at === "number" && Number.isFinite(item.taken_at)
        ? Math.round(item.taken_at)
        : null,
    videoUrl: version ? text(version.url) : null,
    durationSeconds:
      typeof item.video_duration === "number" &&
      Number.isFinite(item.video_duration)
        ? item.video_duration
        : null,
  };
}

export type Account = { id: string; handle: string };

/** The account a `current_user` answer names, or null when it names none. */
export function parseAccount(raw: unknown): Account | null {
  if (!isRecord(raw)) {
    return null;
  }
  const user = isRecord(raw.user) ? raw.user : raw;
  const handle = text(user.username);
  if (!handle) {
    return null;
  }
  return { id: text(user.pk) || text(user.id), handle };
}

/** A number as the reader writes it: `1,234`. */
function count(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

/** The day a second belongs to, in UTC: `2026-11-12`. */
function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** One line, because the panel draws one row per line. */
function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export type FormatOptions = {
  /** Start with the post's own caption. */
  caption?: boolean;
  /** How many comments the post holds, for the line that says what is left. */
  total?: number;
};

/**
 * The post and its comments as the app reads them: every row is one line, and a
 * comment is a line naming who wrote it and one carrying what they wrote.
 */
export function formatPost(
  post: Post,
  comments: Comment[],
  options: FormatOptions = {},
): string {
  const lines: string[] = [];
  let size = 0;
  const push = (line: string) => {
    lines.push(line);
    size += line.length + 1;
  };

  const head = [`@${post.handle || "instagram"}`];
  if (post.comments > 0) {
    head.push(`${count(post.comments)} comments`);
  }
  if (post.at) {
    head.push(day(post.at));
  }
  push(head.join(" · "));

  if (options.caption !== false && post.caption.trim()) {
    push(oneLine(post.caption, MAX_CAPTION_CHARS));
  }

  let shown = 0;
  for (const comment of comments) {
    // A post may hold more than the helper will keep, so the list stops at the
    // cap and the last line says what was left out.
    if (size >= MAX_TEXT_CHARS) {
      break;
    }

    const meta = [
      comment.replyTo ? `↳ @${comment.handle}` : `@${comment.handle}`,
    ];
    if (comment.likes > 0) {
      meta.push(`${count(comment.likes)} likes`);
    }
    if (comment.replies > 0) {
      meta.push(`${count(comment.replies)} replies`);
    }
    if (comment.at) {
      meta.push(day(comment.at));
    }

    push("");
    push(meta.join(" · "));
    if (comment.text.trim()) {
      push(oneLine(comment.text, MAX_COMMENT_CHARS));
    }
    shown += 1;
  }

  const total = options.total ?? post.comments;
  if (total > shown) {
    push("");
    push(`… ${count(total - shown)} more comments on Instagram.`);
  }

  return lines.join("\n").trim();
}

function headers(session: Session): Record<string, string> {
  return {
    "user-agent": BROWSER_USER_AGENT,
    "x-ig-app-id": APP_ID,
    "x-ig-www-claim": "0",
    "x-requested-with": "XMLHttpRequest",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.instagram.com/",
    cookie: session.cookie,
    // A route that checks the token wants it beside the cookie that carries it.
    ...(session.csrf ? { "x-csrftoken": session.csrf } : {}),
  };
}

/** One request, read up to a limit so a large answer cannot exhaust memory. */
async function readJson(
  url: string,
  session: Session,
  options: { redirect?: "follow" | "manual" } = {},
): Promise<{ status: number; body: unknown } | null> {
  const response = await fetch(url, {
    headers: headers(session),
    redirect: options.redirect ?? "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response) {
    return null;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: null };
  }

  const bytes = await readCapped(response, MAX_BODY_BYTES);
  try {
    return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { status: response.status, body: null };
  }
}

async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    const room = limit - total;
    if (value.byteLength >= room) {
      if (room > 0) {
        chunks.push(value.slice(0, room));
        total = limit;
      }
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.subarray(0, offset);
}

const REFUSED =
  "Instagram did not accept this session. Sign in again in a browser on this computer and paste the new sessionid cookie.";

/**
 * The post a link names, read as the signed-in user. The link is read first, so
 * a link that is not a post is told so before a missing session is mentioned.
 */
export async function loadPost(
  link: string,
  session: Session,
): Promise<Post> {
  const code = postCodeOf(link);
  const mediaId = code ? mediaIdOf(code) : null;
  if (!code || !mediaId) {
    throw new PluginError(
      "bad_subject",
      "This link is not an Instagram post. A profile or a story has no post to read.",
    );
  }

  let refused = false;
  for (const host of HOSTS) {
    const answer = await readJson(
      `${host}/api/v1/media/${mediaId}/info/`,
      session,
    );
    if (!answer) {
      continue;
    }
    if (answer.status === 401 || answer.status === 403) {
      refused = true;
      continue;
    }
    const post = parsePost(answer.body);
    if (post) {
      return { ...post, code: post.code || code };
    }
  }

  if (refused) {
    throw new PluginError("refused", REFUSED);
  }
  throw new PluginError(
    "no_data",
    "Instagram returned no post for this link. It may have been deleted, or it may be private.",
  );
}

export type CommentOptions = {
  /** Read the replies under each comment, while the request budget lasts. */
  replies?: boolean;
};

/** The replies under one comment, at most two pages of them. */
async function loadRepliesFor(
  commentId: string,
  session: Session,
): Promise<Comment[]> {
  const replies: Comment[] = [];
  let next: string | null = null;

  for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
    const query = new URLSearchParams({ can_support_threading: "true" });
    if (next) {
      query.set("min_id", next);
    }

    let read: ReplyPage | null = null;
    for (const host of HOSTS) {
      const answer = await readJson(
        `${host}/api/v1/media/${commentId}/child_comments/?${query.toString()}`,
        session,
      );
      // A thread that will not open is a comment without its replies, which is
      // not a reason to lose the comment itself.
      if (!answer || answer.status === 401 || answer.status === 403) {
        continue;
      }
      read = parseReplies(answer.body);
      break;
    }

    if (!read) {
      break;
    }
    replies.push(...read.comments);
    if (!read.more || !read.next) {
      break;
    }
    next = read.next;
  }

  return replies;
}

/**
 * The comment pages of a post, until the limit, the end, or a refusal. The
 * replies under a comment are read as it is reached, so they follow the comment
 * they answer; a budget keeps a popular post from turning into a hundred calls.
 */
export async function loadComments(
  postId: string,
  session: Session,
  limit: number,
  options: CommentOptions = {},
): Promise<{ comments: Comment[]; refused: boolean }> {
  const comments: Comment[] = [];
  const deadline = Date.now() + REPLY_MS;
  let replyCalls = 0;
  let parents = 0;
  let next: string | null = null;
  let refused = false;

  for (let page = 0; page < MAX_PAGES && parents < limit; page += 1) {
    const query = new URLSearchParams({
      can_support_threading: "true",
      permalink_enabled: "false",
    });
    if (next) {
      query.set("min_id", next);
    }

    let read: CommentPage | null = null;
    for (const host of HOSTS) {
      const answer = await readJson(
        `${host}/api/v1/media/${postId}/comments/?${query.toString()}`,
        session,
      );
      if (!answer) {
        continue;
      }
      if (answer.status === 401 || answer.status === 403) {
        refused = true;
        continue;
      }
      read = parseComments(answer.body);
      break;
    }

    if (!read) {
      break;
    }

    for (const comment of read.comments) {
      if (parents >= limit) {
        break;
      }
      comments.push(comment);
      parents += 1;

      const wanted =
        options.replies !== false &&
        comment.replies > 0 &&
        replyCalls < MAX_REPLY_REQUESTS &&
        Date.now() < deadline;
      if (!wanted) {
        continue;
      }

      replyCalls += 1;
      const children = await loadRepliesFor(comment.id, session).catch(
        () => [],
      );
      for (const child of children) {
        comments.push({ ...child, replyTo: comment.handle });
      }
    }

    if (!read.more || !read.next) {
      break;
    }
    next = read.next;
  }

  return { comments, refused };
}

/** The routes that name the signed-in reader, in the order they are asked. */
const ACCOUNT_URLS = [
  "https://i.instagram.com/api/v1/accounts/current_user/",
  "https://www.instagram.com/api/v1/accounts/current_user/?edit=true",
];

/** Why an answer names no account, in words a reader can act on. */
function refusalOf(answer: { status: number; body: unknown }): string {
  if ([301, 302, 303, 307, 308].includes(answer.status)) {
    return "Instagram served the login page";
  }
  if (answer.status === 401 || answer.status === 403) {
    return `Instagram refused it (${String(answer.status)})`;
  }
  if (isRecord(answer.body)) {
    const message = text(answer.body.message);
    if (message) {
      return message;
    }
  }
  return answer.status >= 400 ? `Instagram answered ${String(answer.status)}` : "";
}

/**
 * Whose session this is, which is what the app's sign-in page asks the helper.
 * Instagram's own answer is carried back when it names no account: a login page
 * and a rate limit need different things from the reader, and the generic
 * refusal hid which one it was.
 */
export async function checkSession(session: Session): Promise<string> {
  const reasons: string[] = [];

  for (const url of ACCOUNT_URLS) {
    // A redirect is an answer here: it means the login page was served.
    const answer = await readJson(url, session, { redirect: "manual" });
    if (!answer) {
      reasons.push("Instagram did not answer");
      continue;
    }

    const account = parseAccount(answer.body);
    if (account) {
      return `@${account.handle}`;
    }
    const reason = refusalOf(answer);
    if (reason) {
      reasons.push(reason);
    }
  }

  const unique = [...new Set(reasons)].slice(0, 2).join("; ");
  throw new PluginError(
    "refused",
    `${REFUSED}${unique ? ` Instagram said: ${unique}.` : ""}`,
  );
}

