import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  audioArgs,
  formatCues,
  modelPath,
  parseSrt,
  whisperArgs,
} from "./transcript";

const SRT = `1
00:00:00,000 --> 00:00:02,500
Hello there.

2
00:00:02,500 --> 00:00:05,000
This is a reel.

3
00:01:10,000 --> 00:01:12,000
Much later.
`;

describe("parseSrt", () => {
  it("reads each cue with the second it starts on", () => {
    expect(parseSrt(SRT)).toEqual([
      { start: 0, text: "Hello there." },
      { start: 2, text: "This is a reel." },
      { start: 70, text: "Much later." },
    ]);
  });

  it("answers nothing for text that is not a caption file", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("just words")).toEqual([]);
  });
});

describe("formatCues", () => {
  it("joins cues up to a line and stamps each line", () => {
    const cues = parseSrt(SRT);
    expect(formatCues(cues)).toBe(
      [
        "[00:00] Hello there. This is a reel.",
        "[01:10] Much later.",
      ].join("\n"),
    );
  });

  it("starts a new line once the line is long enough", () => {
    const cues = [
      { start: 0, text: "a".repeat(200) },
      { start: 1, text: "b".repeat(60) },
    ];
    expect(formatCues(cues).split("\n")).toHaveLength(2);
  });
});

describe("arguments", () => {
  it("converts the audio to mono 16 kHz", () => {
    expect(audioArgs("in.mp4", "out.wav")).toEqual([
      "-y",
      "-i",
      "in.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "out.wav",
    ]);
  });

  it("asks whisper for one caption file", () => {
    expect(
      whisperArgs({
        model: "/tmp/model.bin",
        audio: "/tmp/audio.wav",
        language: "auto",
        prefix: "/tmp/speech",
      }),
    ).toEqual([
      "-m",
      "/tmp/model.bin",
      "-f",
      "/tmp/audio.wav",
      "-l",
      "auto",
      "-osrt",
      "-of",
      "/tmp/speech",
      "-np",
    ]);
  });
});

describe("modelPath", () => {
  it("takes the file the settings name", async () => {
    const root = await mkdtemp(join(tmpdir(), "salvage-model-"));
    const model = join(root, "ggml-tiny.bin");
    await writeFile(model, "");
    expect(modelPath(model, root)).toBe(model);
  });

  it("falls back to the model in the plugin's folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "salvage-model-"));
    await mkdir(join(root, "models"));
    await writeFile(join(root, "models", "ggml-base.bin"), "");
    expect(modelPath("", root)).toBe(join(root, "models", "ggml-base.bin"));
  });

  it("answers nothing when the computer holds no model", async () => {
    const root = await mkdtemp(join(tmpdir(), "salvage-model-"));
    expect(modelPath("", root)).toBeNull();
    expect(modelPath(join(root, "missing.bin"), root)).toBeNull();
  });
});
