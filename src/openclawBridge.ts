import { spawn } from "node:child_process";

interface BridgeConfig {
  url: string;
  browserApp: string;
}

function getBridgeConfig(): BridgeConfig {
  return {
    url: process.env.OPENCLAW_URL || "http://localhost:3000",
    browserApp: process.env.OPENCLAW_BROWSER_APP || "Google Chrome"
  };
}

export function openOpenClawTab(): Promise<void> {
  const config = getBridgeConfig();
  return new Promise((resolve, reject) => {
    const script = `tell application "${config.browserApp.replace(/"/g, '\\"')}"\n  activate\n  open location "${config.url.replace(/"/g, '\\"')}"\nend tell`;
    const proc = spawn("osascript", ["-e", script], { stdio: "ignore" });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
    proc.on("error", reject);
  });
}
