import { describe, expect, it } from "bun:test";

import {
  formatPost,
  mediaIdOf,
  parseAccount,
  parseComments,
  parsePost,
  parseReplies,
  postCodeOf,
} from "./instagram";

import type { Comment, Post } from "./instagram";

const POST: Post = {
  id: "3141592653589793238",
  code: "CxYz12345",
  handle: "someone",
  caption: "A caption\nover two lines",
  comments: 3,
  at: 1_760_000_000,
  videoUrl: null,
  durationSeconds: null,
};

const COMMENT: Comment = {
  id: "1",
  handle: "reader",
  text: "first line\nsecond line",
  likes: 4,
  replies: 0,
  at: 1_760_000_100,
};

describe("mediaIdOf", () => {
  it("reads the id a code spells", () => {
    expect(mediaIdOf("A")).toBe("0");
    expect(mediaIdOf("B")).toBe("1");
    expect(mediaIdOf("AB")).toBe("1");
    expect(mediaIdOf("BA")).toBe("64");
    expect(mediaIdOf("_")).toBe("63");
    expect(mediaIdOf("CxYz12345")).toBe("780159164317241");
  });

  it("refuses what is not a code", () => {
    expect(mediaIdOf("has spaces")).toBeNull();
    expect(mediaIdOf("Cx$z12345")).toBeNull();
    expect(mediaIdOf("C".repeat(21))).toBeNull();
    expect(mediaIdOf("")).toBeNull();
  });
});

describe("postCodeOf", () => {
  it("reads a post, a reel, a reels redirect and a television video", () => {
    expect(postCodeOf("https://www.instagram.com/p/CxYz12345/")).toBe(
      "CxYz12345",
    );
    expect(postCodeOf("https://instagram.com/reel/CxYz12345/")).toBe(
      "CxYz12345",
    );
    expect(postCodeOf("https://www.instagram.com/reels/CxYz12345/")).toBe(
      "CxYz12345",
    );
    expect(postCodeOf("https://www.instagram.com/tv/CxYz12345/")).toBe(
      "CxYz12345",
    );
    expect(
      postCodeOf("https://www.instagram.com/someone/p/CxYz12345/"),
    ).toBe("CxYz12345");
    expect(postCodeOf("https://instagr.am/p/CxYz12345/")).toBe("CxYz12345");
  });

  it("finds no post in a profile, a story or another site", () => {
    expect(postCodeOf("https://www.instagram.com/someone/")).toBeNull();
    expect(postCodeOf("https://www.instagram.com/stories/someone/1/")).toBeNull();
    expect(postCodeOf("https://example.com/p/CxYz12345/")).toBeNull();
    expect(postCodeOf("not a link")).toBeNull();
  });
});

describe("parsePost", () => {
  it("reads the fields the post carries", () => {
    const post = parsePost({
      items: [
        {
          pk: "3141592653589793238",
          code: "CxYz12345",
          user: { username: "someone" },
          caption: { text: "A caption" },
          comment_count: 12,
          taken_at: 1_760_000_000,
          video_versions: [{ url: "https://cdn.example/video.mp4" }],
          video_duration: 12.5,
        },
      ],
    });

    expect(post).toEqual({
      id: "3141592653589793238",
      code: "CxYz12345",
      handle: "someone",
      caption: "A caption",
      comments: 12,
      at: 1_760_000_000,
      videoUrl: "https://cdn.example/video.mp4",
      durationSeconds: 12.5,
    });
  });

  it("reads the older caption shape, and a picture has no video", () => {
    const post = parsePost({
      items: [
        {
          id: "42",
          owner: { username: "someone" },
          edge_media_to_caption: { edges: [{ node: { text: "Older" } }] },
        },
      ],
    });

    expect(post?.caption).toBe("Older");
    expect(post?.id).toBe("42");
    expect(post?.videoUrl).toBeNull();
  });

  it("answers nothing for an empty answer", () => {
    expect(parsePost({ items: [] })).toBeNull();
    expect(parsePost(null)).toBeNull();
  });
});

describe("parseComments", () => {
  it("reads a page and the cursor after it", () => {
    const page = parseComments({
      comments: [
        {
          pk: "9",
          text: "hello",
          created_at: 1_760_000_100,
          user: { username: "reader" },
          comment_like_count: 4,
          child_comment_count: 2,
        },
      ],
      next_min_id: "9",
      has_more_comments: true,
    });

    expect(page.comments).toEqual([
      {
        id: "9",
        handle: "reader",
        text: "hello",
        likes: 4,
        replies: 2,
        at: 1_760_000_100,
      },
    ]);
    expect(page.next).toBe("9");
    expect(page.more).toBe(true);
  });

  it("stops at the end of the list", () => {
    const page = parseComments({
      comments: [{ text: "hello", user: { username: "reader" } }],
      has_more_comments: false,
    });

    expect(page.more).toBe(false);
    expect(page.next).toBeNull();
    expect(page.comments).toHaveLength(1);
  });

  it("drops a comment with no author", () => {
    expect(parseComments({ comments: [{ text: "x" }] }).comments).toHaveLength(
      0,
    );
  });
});

describe("parseAccount", () => {
  it("names the account a session belongs to", () => {
    expect(parseAccount({ user: { pk: "42", username: "someone" } })).toEqual({
      id: "42",
      handle: "someone",
    });
    expect(parseAccount({ id: "42", username: "someone" })?.handle).toBe(
      "someone",
    );
  });

  it("answers nothing when the session belongs to no account", () => {
    expect(parseAccount({ user: {} })).toBeNull();
    expect(parseAccount(null)).toBeNull();
  });
});

describe("parseReplies", () => {
  it("reads a page of replies and the cursor after it", () => {
    const page = parseReplies({
      child_comments: [
        { pk: "5", text: "yes", user: { username: "other" } },
      ],
      has_more_tail_child_comments: true,
      next_max_child_cursor: "5",
    });

    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].handle).toBe("other");
    expect(page.next).toBe("5");
    expect(page.more).toBe(true);
  });

  it("answers nothing when there is no thread to read", () => {
    expect(parseReplies({ child_comments: [] }).more).toBe(false);
    expect(parseReplies(null)).toEqual({
      comments: [],
      next: null,
      more: false,
    });
  });
});

describe("formatPost", () => {
  it("writes one row per comment, and one line per row", () => {
    const text = formatPost(POST, [COMMENT], { total: 3 });
    const rows = text.split("\n");

    expect(rows[0]).toBe("@someone · 3 comments · 2025-10-09");
    expect(rows[1]).toBe("A caption over two lines");
    expect(rows).toContain("@reader · 4 likes · 2025-10-09");
    expect(rows).toContain("first line second line");
    expect(text).toContain("… 2 more comments on Instagram.");
  });

  it("leaves the caption out when it is not wanted", () => {
    const text = formatPost(POST, [COMMENT], {
      caption: false,
      total: 1,
    });

    expect(text).not.toContain("A caption");
    expect(text).not.toContain("more comments");
  });

  it("marks a reply under the comment it answers", () => {
    const text = formatPost(
      POST,
      [{ ...COMMENT, replyTo: "someone", likes: 0 }],
      { total: 1 },
    );

    expect(text).toContain("↳ @reader");
  });

  it("stops before the helper's own limit and counts the rest", () => {
    const many: Comment[] = Array.from({ length: 500 }, (_, index) => ({
      ...COMMENT,
      id: String(index),
      text: "x".repeat(2_000),
      at: null,
    }));

    const text = formatPost(POST, many, { total: 500 });
    expect(text.length).toBeLessThan(201_000);
    expect(text).toContain("more comments on Instagram.");
    expect(text.split("\n").length).toBeGreaterThan(2);
  });

  it("keeps a handle the answer did not carry", () => {
    const text = formatPost({ ...POST, handle: "" }, [COMMENT], { total: 1 });
    expect(text.split("\n")[0]).toStartWith("@instagram");
  });
});
