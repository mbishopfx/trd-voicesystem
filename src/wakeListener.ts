import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

interface WakeListenerConfig {
  wakeWords: string[];
  openUrl: string;
  captureSeconds: number;
  browserApp: string;
  voiceMode: "text" | "browser";
}

const DEFAULT_URL = process.env.OPENCLAW_URL || "http://localhost:3000";
const DEFAULT_WAKE_WORDS = (process.env.OPENCLAW_WAKE_WORDS || "hey jarvis")
  .split(",")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function getConfig(): WakeListenerConfig {
  return {
    wakeWords: DEFAULT_WAKE_WORDS.length ? DEFAULT_WAKE_WORDS : ["jarvis"],
    openUrl: DEFAULT_URL,
    captureSeconds: envInt("OPENCLAW_CAPTURE_SECONDS", 8),
    browserApp: process.env.OPENCLAW_BROWSER_APP || "Google Chrome",
    voiceMode: (process.env.OPENCLAW_VOICE_MODE as "text" | "browser") || "browser"
  };
}

function includesWakeWord(line: string, wakeWords: string[]): boolean {
  const normalized = line.toLowerCase();
  return wakeWords.some((wakeWord) => normalized.includes(wakeWord));
}

function openBrowser(url: string, browserApp: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `tell application "${browserApp.replace(/"/g, '\\"')}"\n  activate\n  open location "${url.replace(/"/g, '\\"')}"\nend tell`;
    const proc = spawn("osascript", ["-e", script], { stdio: "ignore" });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
    proc.on("error", reject);
  });
}

async function appendLog(message: string): Promise<void> {
  const logPath = path.join(process.cwd(), "logs", "wake-listener.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function main(): Promise<void> {
  const config = getConfig();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  console.log(`[wake-listener] armed for: ${config.wakeWords.join(", ")}`);

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    await appendLog(`heard: ${line.trim()}`);

    if (!includesWakeWord(line, config.wakeWords)) return;

    await appendLog(`wake detected, opening ${config.openUrl}`);
    try {
      await openBrowser(config.openUrl, config.browserApp);
      await appendLog(`browser opened (${config.browserApp})`);
      if (config.voiceMode === "browser") {
        console.log(`[wake-listener] opened OpenClaw, ready for voice message capture (${config.captureSeconds}s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(`open failed: ${message}`);
      console.error(`[wake-listener] failed to open browser: ${message}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
