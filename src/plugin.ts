import { formatPost, loadComments, loadPost, sessionFrom } from "./instagram";
import { PluginError, serve } from "./sdk";
import { savedAnswer, saveAnswer } from "./store";
import { modelPath, transcribe } from "./transcript";

const KIND_COMMENTS = "instagram-comments";
const KIND_TRANSCRIPT = "instagram-transcript";

const DEFAULT_COMMENTS = 100;
const MIN_COMMENTS = 10;
const MAX_COMMENTS = 500;
const DEFAULT_KEEP_DAYS = 7;
const MAX_KEEP_DAYS = 365;
const DEFAULT_LANGUAGE = "auto";

/** The plugin's own folder for the model, kept answers and job files. */
function dataRoot(): string {
  return process.env.SALVAGE_PLUGIN_DATA ?? ".";
}

/** How many comments to read, from a setting the helper already validated. */
function commentsOf(value: unknown): number {
  const wanted =
    typeof value === "number" ? Math.round(value) : DEFAULT_COMMENTS;
  return Math.min(MAX_COMMENTS, Math.max(MIN_COMMENTS, wanted));
}

/**
 * How long a kept answer stays one. Zero keeps it until the plugin's own data
 * is removed, which is what a transcript wants and a comment thread does not.
 */
function keepMs(value: unknown): number {
  const days = typeof value === "number" ? Math.round(value) : DEFAULT_KEEP_DAYS;
  const kept = Math.min(MAX_KEEP_DAYS, Math.max(0, days));
  return kept * 24 * 60 * 60 * 1000;
}

/** The language whisper is told to expect, or `auto` when it should listen. */
function languageOf(value: unknown): string {
  return typeof value === "string" && /^[a-z]{2,3}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : DEFAULT_LANGUAGE;
}

/** A kept answer read as the panel reads a fresh one, saying when it was kept. */
function keptText(text: string, savedAt: number): string {
  const day = new Date(savedAt).toISOString().slice(0, 10);
  return `${text}\n\n— saved on this computer · ${day}`;
}

export default () =>
  serve(async ({ command, params }) => {
    if (command !== "comments" && command !== "transcript") {
      throw new PluginError("unsupported", `Unknown command ${command}.`);
    }

    const link = params.subject?.link?.url;
    if (!link) {
      throw new PluginError("bad_subject", "This entry has no link.");
    }

    const root = dataRoot();
    const entryId = params.subject?.entryId ?? "";
    const kind = command === "comments" ? KIND_COMMENTS : KIND_TRANSCRIPT;
    // Only comments are kept here. A transcript goes to the account instead,
    // where the web application stores it in the slot every device reads.
    const keep =
      command === "comments" && params.settings?.keepAnswer !== false;

    // A kept answer is read before Instagram is asked, so it outlives the
    // session that fetched it: an expired cookie does not hide what is here.
    if (keep) {
      const saved = await savedAnswer({
        root,
        entryId,
        kind,
        maxAgeMs: keepMs(params.settings?.keepDays),
      });
      if (saved) {
        return { kind, text: keptText(saved.text, saved.savedAt) };
      }
    }

    // The post is read first: a link that is not one is answered as such, and
    // only a post asks for the session the answer needs.
    const post = await loadPost(link, params.secrets?.sessionid);
    const session = sessionFrom(params.secrets);

    if (command === "comments") {
      const { comments, refused } = await loadComments(
        post.id,
        session,
        commentsOf(params.settings?.maxComments),
        { replies: params.settings?.includeReplies !== false },
      );

      if (comments.length === 0) {
        if (refused) {
          throw new PluginError(
            "refused",
            "Instagram did not hand over this post's comments. Sign in again in a browser on this computer and paste the new sessionid cookie.",
          );
        }
        throw new PluginError(
          "no_data",
          post.comments > 0
            ? "Instagram returned none of this post's comments. It may show them only to signed-in accounts that follow the author."
            : "This post has no comments yet.",
        );
      }

      const text = formatPost(post, comments, {
        caption: params.settings?.includeCaption !== false,
        total: post.comments,
      });
      if (keep) {
        await saveAnswer({ root, entryId, kind, text });
      }
      return { kind, text };
    }

    if (!post.videoUrl) {
      throw new PluginError(
        "no_data",
        "This post has no video to transcribe. A picture post has only its caption.",
      );
    }

    const text = await transcribe({
      videoUrl: post.videoUrl,
      code: post.code || post.id,
      session,
      model: modelPath(params.settings?.whisperModel, root),
      language: languageOf(params.settings?.language),
      dataRoot: root,
    });
    if (keep) {
      await saveAnswer({ root, entryId, kind, text });
    }
    return { kind, text };
  });
