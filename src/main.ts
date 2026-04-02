import { config } from "./config.js";
import { processDueBdcActions } from "./bdcAutomations.js";
import { ingestOnce } from "./ingest.js";
import { createServer } from "./server.js";
import { effectiveCps } from "./config.js";
import { TokenBucket } from "./rateLimiter.js";
import { dialOneLead } from "./worker.js";
import { isMainModule, sleep } from "./utils.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { startBulkCampaignScheduler } from "./bulkCampaignScheduler.js";

async function startIngestionScheduler(): Promise<void> {
  if (config.runIngestOnStart) {
    const summaries = await ingestOnce();
    for (const summary of summaries) {
      runtimeInfo(
        "ingest",
        `${summary.file} rows=${summary.rows} accepted=${summary.accepted} blocked=${summary.blocked} duplicates=${summary.duplicates} invalid=${summary.invalid}`
      );
    }
  }

  const intervalMs = config.ingestIntervalHours * 60 * 60 * 1000;
  setInterval(() => {
    ingestOnce()
      .then((summaries) => {
        for (const summary of summaries) {
          runtimeInfo(
            "ingest",
            `${summary.file} rows=${summary.rows} accepted=${summary.accepted} blocked=${summary.blocked} duplicates=${summary.duplicates} invalid=${summary.invalid}`
          );
        }
      })
      .catch((error) => {
        runtimeError("ingest", "scheduler error", error);
      });
  }, intervalMs);
}

async function startDialer(): Promise<void> {
  const cps = effectiveCps();
  const limiter = new TokenBucket(cps, Math.max(1, cps));
  let inFlight = 0;

  runtimeInfo(
    "dialer",
    `started | effectiveCps=${cps.toFixed(2)} | maxConcurrent=${config.maxConcurrentDials} | tickMs=${config.dialerTickMs}`
  );

  while (true) {
    try {
      const due = await processDueBdcActions();
      if (due.processed > 0) {
        runtimeInfo("scheduler", "bdc due actions processed", due);
      }
    } catch (error) {
      runtimeError("scheduler", "bdc action loop failed", error);
    }

    while (inFlight < config.maxConcurrentDials && limiter.tryTake(1)) {
      inFlight += 1;
      dialOneLead()
        .then((result) => {
          if (result.dispatched) runtimeInfo("dialer", result.message);
        })
        .catch((error) => {
          runtimeError("dialer", "fatal dispatch error", error);
        })
        .finally(() => {
          inFlight -= 1;
        });
    }

    await sleep(config.dialerTickMs);
  }
}

async function main(): Promise<void> {
  process.env.DIALER_RUNTIME = "enabled";
  const app = createServer();
  app.listen(config.port, () => {
    runtimeInfo("server", `Listening on :${config.port}`);
  });

  await startIngestionScheduler();
  await startBulkCampaignScheduler();
  await startDialer();
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    runtimeError("server", "main runtime crash", error);
    process.exit(1);
  });
}
