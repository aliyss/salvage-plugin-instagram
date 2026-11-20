# Instagram for Salvage

A [Salvage](https://github.com/aliyss/salvage-web) plugin that reads an
Instagram post's caption and comments, and transcribes the spoken words of a
Reel, on your own computer.

## Read this first

Instagram has no API for a post that someone else made. This plugin therefore
reads the post with **your own signed-in session**: you paste the `sessionid`
cookie of a browser on this computer, and the helper uses it to call the same
private endpoints the Instagram page calls.

Three consequences follow.

- This is against Instagram's terms of use. Instagram may limit or lock the
  account whose session is used. Use an account you are willing to lose, or
  accept that risk knowingly.
- The endpoints are private, so Instagram may change or close them without
  notice. A release of this plugin may stop working on any day.
- The session is a login credential. It is kept in the helper's own folder for
  this plugin and is never sent to the Salvage web application. Remove it from
  the plugin's page when you are done with it.

For the compliant path — your own professional account, with comments through
the Instagram Graph API — a different plugin is needed. This one is for reading
public posts.

## What it adds

On an entry whose link is an Instagram post, the link card gets two buttons.

- **Comments** reads the caption and the comments of the post, newest first,
  with the replies under a comment marked `↳` after it.
- **Transcript** downloads the Reel, converts its audio and transcribes it with
  whisper.cpp on this computer. A picture post has no transcript.

Both answers are shown in the entry's panel. A transcript is handed to the web
application, which stores it on the entry, so it survives a reload, reaches the
other devices signed in to the account, and is read on the next visit without
transcribing again. Comments are kept on this computer only, for the reasons
below.

## Kept comments

A comment thread lives in the plugin's own folder, named after the entry that
made it:

```
<helper data>/plugins/salvage-plugin-instagram/saved/<entry id>.instagram-comments.json
```

It is not in the database. Three things follow.

- It survives a reload, and it outlives the session that fetched it.
- The archive cannot search it, and no other computer holds a copy. Only that
  entry, on this computer, reads it back.
- Removing the plugin's data removes every kept thread.

**How many days a kept thread lasts** decides when a press asks Instagram again.
Set it to `0` to keep a thread until the data is removed. **Keep the thread on
this computer** turns the store off; every press then reads Instagram.

A transcript is not kept here. The web application stores it on the entry, so it
is part of the account rather than of this computer.

A kept answer ends with the day it was kept, so an old comment thread is never
mistaken for a fresh one.

## Requirements

- Salvage with the desktop helper paired
- Plugin API version 1
- An Instagram session you are signed in with, in a browser on the same computer
- For transcripts: `ffmpeg` and a `whisper.cpp` binary (`whisper-cli`,
  `whisper-cpp` or `whisper`) on the helper's PATH, and a GGML model

## Install

Open **Settings → Plugins → Browse store** and find this repository, or drop a
folder containing `manifest.json` and `dist/plugin.js` into the helper's plugins
folder and press **Rescan**.

## Getting the session

1. Sign in to Instagram in a browser on the computer that runs the helper.
2. Open the browser's developer tools, then **Application** (Chrome) or
   **Storage** (Firefox), then **Cookies → https://www.instagram.com**.
3. Copy the **value** of `sessionid`. It is long, and it usually ends in `%3A`.
   Copying the whole row — `sessionid=…` — works too, and is better when the
   browser shows `csrftoken` beside it: paste both names together, separated by
   `; `, and the plugin sends `x-csrftoken` with the cookie. Another name in the
   header is dropped.
4. Paste it into **Instagram session id** on the plugin's page.

The value is a secret: the helper stores it beside the plugin, and the web
application never sees it. Signing out of that browser ends the session, so
paste a new one after that.

Instagram binds a session to the browser that made it. A value copied on one
computer and used on another is often refused, and the refusal says so: the
plugin reports what Instagram answered — the login page, a 401 or 403, or
Instagram's own message — beside the check.

## Getting a transcript model

Download `ggml-base.bin` (about 148 MB) or a smaller `ggml-tiny.bin` from
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main),
and save it in the plugin's own folder:

```
<helper data>/plugins/salvage-plugin-instagram/models/ggml-base.bin
```

The first model found there is used. **Whisper model file** in the settings
names a file somewhere else instead.

A larger model is slower. The helper gives a plugin one minute, so a clip of
about a minute is the practical limit with `tiny` or `base` on a laptop. A
longer clip is stopped before the minute is up and says so.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Instagram session id | — | The `sessionid` cookie, kept on this computer |
| How many comments | 100 | Comments read per press, newest first |
| Start with the caption | on | Put the post's own caption above the comments |
| Read the replies under a comment | on | Fetch a thread, up to 25 requests per press |
| Keep the comment thread on this computer | on | Show the kept thread instead of asking again |
| How many days a kept thread lasts | 7 | Age after which a press asks Instagram (0 never) |
| Whisper model file | empty | A model outside the plugin's `models/` folder |
| Spoken language | auto | The language whisper expects; `auto` lets it listen |

## What is not read

- **Every reply of a long thread.** The first two pages of a comment's replies
  are read, and at most twenty-five threads per press. A comment says how many
  replies it has, so a cut thread is visible.
- **Search and sync of a comment thread.** A kept thread is a file on this
  computer. The archive does not index it, and another device does not see it.
  A transcript is different: the web application stores it on the entry.
- **Stories, highlights and profiles.** Only `/p/`, `/reel/`, `/reels/` and
  `/tv/` links name a post.
- **Private posts** the session cannot see.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build     # writes dist/plugin.js
```

The plugin talks to the helper over stdin/stdout using the small SDK in
`src/sdk.ts`; `bun run dev` runs it directly.

## Releasing

Every push to `master` builds the bundle, runs the tests, and publishes a
GitHub release **in this repository**, tagged `v<version>` from `manifest.json`,
with `plugin.js` and `manifest.json` attached. No tag push is needed.

Bump `version` in `manifest.json` when a commit should reach installed copies.

Repositories tagged with the GitHub topic **`salvage-plugin`** appear in the
store automatically, sorted by stars.

## License

MIT
