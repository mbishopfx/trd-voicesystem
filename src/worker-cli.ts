import { config, effectiveCps } from "./config.js";
import { TokenBucket } from "./rateLimiter.js";
import { dialOneLead } from "./worker.js";
import { isMainModule, sleep } from "./utils.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";

async function main(): Promise<void> {
  const cps = effectiveCps();
  const limiter = new TokenBucket(cps, Math.max(1, cps));

  runtimeInfo(
    "worker",
    `started | effectiveCps=${cps.toFixed(2)} | maxConcurrent=${config.maxConcurrentDials} | tickMs=${config.dialerTickMs}`
  );

  let inFlight = 0;

  while (true) {
    while (inFlight < config.maxConcurrentDials && limiter.tryTake(1)) {
      inFlight += 1;
      dialOneLead()
        .then((result) => {
          if (result.dispatched) runtimeInfo("worker", result.message);
        })
        .catch((error) => {
          runtimeError("worker", "fatal dispatch error", error);
        })
        .finally(() => {
          inFlight -= 1;
        });
    }

    await sleep(config.dialerTickMs);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    runtimeError("worker", "worker runtime crash", error);
    process.exit(1);
  });
}
