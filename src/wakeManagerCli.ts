import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--import", "tsx", "src/wakeManager.ts"], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd()
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
