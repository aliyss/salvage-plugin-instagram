/**
 * Transcribes the spoken words of a Reel on this computer.
 *
 * Instagram publishes no transcript and no caption track, so the words have to
 * be heard: the video is downloaded, its audio is converted by ffmpeg, and
 * whisper.cpp writes the text. Both tools are read from this computer's PATH,
 * because the helper ships neither and neither has a small build to ship.
 *
 * The helper gives a plugin one minute, so a long clip cannot finish here. The
 * limit is stated rather than hidden: the command stops before the helper does
 * and says what happened.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { PluginError } from "./sdk";

import type { Session } from "./cookies";

/** The caption format whisper.cpp writes, one cue per block. */
const TIMING =
  /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

/** Longest download this plugin will make, so a huge file cannot fill a disk. */
const MAX_VIDEO_BYTES = 240 * 1024 * 1024;

/** How much of the one minute belongs to the download and the tools. */
const WORK_MS = 50_000;

const MODEL_DIR = "models";
const DEFAULT_MODEL = "ggml-base.bin";
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

export type Cue = { start: number; text: string };

/** The cues of a SubRip file, in order, with their start in seconds. */
export function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      continue;
    }

    const timing = lines.find((line) => TIMING.test(line));
    if (!timing) {
      continue;
    }
    const match = TIMING.exec(timing);
    if (!match) {
      continue;
    }

    const start =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const text = lines
      .filter((line) => line !== timing && !/^\d+$/.test(line.trim()))
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      cues.push({ start, text });
    }
  }

  return cues;
}

function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Cues as the transcript panel reads them: `[mm:ss] text`. Whisper writes one
 * cue per breath, which reads as a stutter, so cues are joined up to a line.
 */
export function formatCues(
  cues: Cue[],
  lineSeconds = 15,
  lineChars = 240,
): string {
  const lines: string[] = [];
  let start = -1;
  let length = 0;
  let parts: string[] = [];

  const flush = () => {
    const text = parts.join(" ").trim();
    if (text) {
      lines.push(`[${stamp(Math.max(0, start))}] ${text}`);
    }
    parts = [];
    length = 0;
    start = -1;
  };

  for (const cue of cues) {
    if (
      start >= 0 &&
      (length + cue.text.length > lineChars ||
        cue.start - start >= lineSeconds)
    ) {
      flush();
    }
    if (start < 0) {
      start = cue.start;
    }
    parts.push(cue.text);
    length += cue.text.length;
  }
  flush();

  return lines.join("\n");
}

/** The audio arguments: mono 16 kHz PCM, which is what whisper.cpp reads. */
export function audioArgs(input: string, output: string): string[] {
  return [
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    output,
  ];
}

/** The whisper arguments: one SRT file named after the output prefix. */
export function whisperArgs(input: {
  model: string;
  audio: string;
  language: string;
  prefix: string;
}): string[] {
  return [
    "-m",
    input.model,
    "-f",
    input.audio,
    "-l",
    input.language || "auto",
    "-osrt",
    "-of",
    input.prefix,
    "-np",
  ];
}

/** A model this computer holds: the setting, or the one in the plugin's folder. */
export function modelPath(
  setting: unknown,
  dataRoot: string,
): string | null {
  const wanted = typeof setting === "string" ? setting.trim() : "";
  if (wanted) {
    return existsSync(wanted) ? wanted : null;
  }

  const folder = join(dataRoot, MODEL_DIR);
  try {
    const found = readdirSync(folder)
      .filter((name) => name.endsWith(".bin"))
      .sort()[0];
    return found ? join(folder, found) : null;
  } catch {
    return null;
  }
}

/** The message a computer without a model is given. */
export const MISSING_MODEL = `This computer holds no whisper model. Download ${DEFAULT_MODEL} from ${MODEL_URL} and save it as ${MODEL_DIR}/${DEFAULT_MODEL} in the plugin's own folder, or name the file in the plugin's settings.`;

function which(...names: string[]): string | null {
  for (const name of names) {
    const found = Bun.which(name);
    if (found) {
      return found;
    }
  }
  return null;
}

function missing(tool: string, hint: string): PluginError {
  return new PluginError(
    "internal",
    `${tool} is not on this computer's PATH. ${hint}`,
  );
}

/** One command, killed when the time it was given runs out. */
async function run(
  command: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (timeoutMs <= 0) {
    throw new PluginError(
      "internal",
      `${label} did not finish in a minute, which is all the helper gives a plugin. Try a shorter clip.`,
    );
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (error) {
    throw new PluginError(
      "internal",
      error instanceof Error ? error.message : `${label} could not start.`,
    );
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const stderr = await new Response(
    child.stderr as ReadableStream<Uint8Array>,
  ).text();
  const code = await child.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new PluginError(
      "internal",
      `${label} did not finish in a minute, which is all the helper gives a plugin. Try a shorter clip.`,
    );
  }
  if (code !== 0) {
    const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 240);
    throw new PluginError(
      "internal",
      `${label} failed${detail ? `: ${detail}` : "."}`,
    );
  }
}

export type Transcribe = {
  videoUrl: string;
  code: string;
  session: Session;
  model: string | null;
  language: string;
  dataRoot: string;
};

/**
 * The transcript of one video. The files live in the plugin's own folder and
 * are removed once the text has been read, so a clip is downloaded once.
 */
export async function transcribe(input: Transcribe): Promise<string> {
  const ffmpeg = which("ffmpeg");
  const whisper = which("whisper-cli", "whisper-cpp", "whisper");
  if (!ffmpeg) {
    throw missing(
      "ffmpeg",
      "Install it from https://ffmpeg.org and open a new terminal for the helper.",
    );
  }
  if (!whisper) {
    throw missing(
      "whisper.cpp",
      "Build whisper-cli from https://github.com/ggerganov/whisper.cpp and put it on the PATH.",
    );
  }
  if (!input.model) {
    throw new PluginError("internal", MISSING_MODEL);
  }

  const started = Date.now();
  const left = () => WORK_MS - (Date.now() - started);
  const folder = join(input.dataRoot, "jobs", input.code || "reel");
  const video = join(folder, "video.mp4");
  const audio = join(folder, "audio.wav");
  const prefix = join(folder, "speech");

  try {
    await mkdir(folder, { recursive: true });

    const response = await fetch(input.videoUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer: "https://www.instagram.com/",
        cookie: input.session.cookie,
        ...(input.session.csrf ? { "x-csrftoken": input.session.csrf } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1_000, left())),
    }).catch(() => null);

    if (!response?.ok) {
      await response?.body?.cancel().catch(() => undefined);
      throw new PluginError(
        "refused",
        "Instagram did not serve the video. The session may have expired.",
      );
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new PluginError("no_data", "This video is too large to transcribe here.");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new PluginError("no_data", "Instagram served an empty video.");
    }
    if (bytes.byteLength > MAX_VIDEO_BYTES) {
      throw new PluginError("no_data", "This video is too large to transcribe here.");
    }
    await Bun.write(video, bytes);

    await run([ffmpeg, ...audioArgs(video, audio)], left(), "ffmpeg");
    const speech = whisperArgs({
      model: input.model,
      audio,
      language: input.language,
      prefix,
    });
    await run([whisper, ...speech], left(), "whisper");

    const srt = await Bun.file(`${prefix}.srt`).text().catch(() => "");
    const text = formatCues(parseSrt(srt));
    if (!text) {
      throw new PluginError(
        "no_data",
        "There was no speech to transcribe in this clip.",
      );
    }

    // The transcript is all that is kept; the video and the audio are not.
    return text;
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
