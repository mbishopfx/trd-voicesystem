import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openOpenClawTab } from "./openclawBridge.js";

interface WakeManagerConfig {
  wakeWords: string[];
  captureSeconds: number;
  pauseSeconds: number;
  browserApp: string;
  url: string;
  whisperModel: string;
  micInput: string;
  mode: "capture" | "text";
  localWakeEndpoint?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function getConfig(): WakeManagerConfig {
  return {
    wakeWords: (process.env.OPENCLAW_WAKE_WORDS || "hey jarvis")
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    captureSeconds: envInt("OPENCLAW_CAPTURE_SECONDS", 6),
    pauseSeconds: envInt("OPENCLAW_WAKE_PAUSE_SECONDS", 2),
    browserApp: process.env.OPENCLAW_BROWSER_APP || "Google Chrome",
    url: process.env.OPENCLAW_URL || "http://127.0.0.1:18789/",
    whisperModel: process.env.OPENCLAW_WHISPER_MODEL || "base",
    micInput: process.env.OPENCLAW_MIC_INPUT || ":0",
    mode: (process.env.OPENCLAW_WAKE_MODE as "capture" | "text") || "capture",
    localWakeEndpoint: process.env.OPENCLAW_WAKE_ENDPOINT || "http://127.0.0.1:4337/wake"
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordAudio(seconds: number, outFile: string, micInput: string): Promise<void> {
  const ffmpeg = process.env.OPENCLAW_FFMPEG || "/opt/homebrew/bin/ffmpeg";
  const result = await run(ffmpeg, ["-y", "-f", "avfoundation", "-i", micInput, "-t", String(seconds), outFile]);
  if (result.code !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.code}`);
}

async function transcribe(audioFile: string, model: string): Promise<string> {
  const whisper = process.env.OPENCLAW_WHISPER_BIN || "/opt/homebrew/bin/whisper";
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whisper-"));
  const result = await run(whisper, [audioFile, "--model", model, "--output_dir", outputDir, "--output_format", "txt"]);
  if (result.code !== 0) throw new Error(result.stderr || `whisper exited ${result.code}`);
  const txtFile = path.join(outputDir, `${path.basename(audioFile, path.extname(audioFile))}.txt`);
  return (await fs.readFile(txtFile, "utf8")).trim();
}

function hasWakeWord(text: string, wakeWords: string[]): boolean {
  const normalized = text.toLowerCase();
  return wakeWords.some((wakeWord) => normalized.includes(wakeWord));
}

async function notifyLocalWakeEndpoint(url: string, phrase: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phrase })
    });
  } catch {
    // best effort only
  }
}

async function loopCaptureMode(config: WakeManagerConfig): Promise<void> {
  console.log(`[wake-manager] armed for: ${config.wakeWords.join(", ")}`);
  console.log(`[wake-manager] capture=${config.captureSeconds}s pause=${config.pauseSeconds}s model=${config.whisperModel}`);

  while (true) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capture-"));
    const audioFile = path.join(tempDir, "wake.m4a");

    try {
      await recordAudio(config.captureSeconds, audioFile, config.micInput);
      const transcript = await transcribe(audioFile, config.whisperModel);
      if (!transcript) {
        console.log("[wake-manager] silence");
        await sleep(config.pauseSeconds * 1000);
        continue;
      }

      console.log(`[wake-manager] heard: ${transcript}`);
      if (!hasWakeWord(transcript, config.wakeWords)) {
        await sleep(config.pauseSeconds * 1000);
        continue;
      }

      await openOpenClawTab();
      console.log(`[wake-manager] wake detected, OpenClaw opened at ${config.url}`);
      await notifyLocalWakeEndpoint(config.localWakeEndpoint || "", transcript);
      await sleep(config.pauseSeconds * 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[wake-manager] ${message}`);
      await sleep(config.pauseSeconds * 1000);
    }
  }
}

async function loopTextMode(config: WakeManagerConfig): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  console.log(`[wake-manager] text mode armed for: ${config.wakeWords.join(", ")}`);
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    const transcript = line.trim();
    console.log(`[wake-manager] heard: ${transcript}`);
    if (!hasWakeWord(transcript, config.wakeWords)) return;
    await openOpenClawTab();
    console.log(`[wake-manager] wake detected, OpenClaw opened at ${config.url}`);
    await notifyLocalWakeEndpoint(config.localWakeEndpoint || "", transcript);
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  if (config.mode === "text") {
    await loopTextMode(config);
    return;
  }
  await loopCaptureMode(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
