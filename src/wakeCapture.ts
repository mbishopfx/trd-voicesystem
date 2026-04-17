import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openOpenClawTab } from "./openclawBridge.js";

interface CaptureConfig {
  seconds: number;
  wakeWords: string[];
  browserApp: string;
  url: string;
  whisperModel: string;
  device: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function getConfig(): CaptureConfig {
  return {
    seconds: envInt("OPENCLAW_CAPTURE_SECONDS", 8),
    wakeWords: (process.env.OPENCLAW_WAKE_WORDS || "jarvis,openclaw,hey jarvis")
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    browserApp: process.env.OPENCLAW_BROWSER_APP || "Google Chrome",
    url: process.env.OPENCLAW_URL || "http://localhost:3000",
    whisperModel: process.env.OPENCLAW_WHISPER_MODEL || "base",
    device: process.env.OPENCLAW_MIC_DEVICE || ":0"
  };
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    proc.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function recordAudio(seconds: number, outFile: string): Promise<void> {
  const ffmpeg = process.env.OPENCLAW_FFMPEG || "/opt/homebrew/bin/ffmpeg";
  const args = [
    "-y",
    "-f",
    "avfoundation",
    "-i",
    process.env.OPENCLAW_MIC_INPUT || ":0",
    "-t",
    String(seconds),
    outFile
  ];
  const result = await run(ffmpeg, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || `ffmpeg exited ${result.code}`);
  }
}

async function transcribe(audioFile: string, model: string): Promise<string> {
  const whisper = process.env.OPENCLAW_WHISPER_BIN || "/opt/homebrew/bin/whisper";
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whisper-"));
  const result = await run(whisper, [audioFile, "--model", model, "--output_dir", outputDir, "--output_format", "txt"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `whisper exited ${result.code}`);
  }
  const txtFile = path.join(outputDir, `${path.basename(audioFile, path.extname(audioFile))}.txt`);
  return fs.readFile(txtFile, "utf8");
}

function hasWakeWord(text: string, wakeWords: string[]): boolean {
  const normalized = text.toLowerCase();
  return wakeWords.some((wakeWord) => normalized.includes(wakeWord));
}

async function main(): Promise<void> {
  const config = getConfig();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capture-"));
  const audioFile = path.join(tempDir, "wake.m4a");

  console.log(`[wake-capture] recording ${config.seconds}s, waiting for wake phrase...`);
  await recordAudio(config.seconds, audioFile);

  const transcript = (await transcribe(audioFile, config.whisperModel)).trim();
  console.log(`[wake-capture] transcript: ${transcript || "<empty>"}`);

  if (!transcript || !hasWakeWord(transcript, config.wakeWords)) {
    console.log("[wake-capture] no wake phrase detected");
    return;
  }

  await openOpenClawTab();
  console.log(`[wake-capture] wake detected, OpenClaw opened at ${config.url}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
