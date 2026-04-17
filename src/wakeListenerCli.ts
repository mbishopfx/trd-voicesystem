import { spawn } from "node:child_process";

const listener = spawn(process.execPath, ["--import", "tsx", "src/wakeListener.ts"], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd()
});

listener.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
