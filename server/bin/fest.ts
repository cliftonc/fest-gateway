#!/usr/bin/env node
/**
 * Fest entrypoint.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, describeConfig } from "../config.ts";
import { createUsageSink } from "../ingest/sink.ts";
import { createServer } from "../http/server.ts";
import { log, setLogLevel } from "../log.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  await mkdir(dirname(config.usageLogPath), { recursive: true });
  const sink = createUsageSink({ path: config.usageLogPath });
  const server = createServer({ config, sink });

  // Drain the metering queue on shutdown rather than losing what is buffered.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    server.close(() => {
      void sink.close().then(() => {
        log.info("drained", { sink: sink.stats() });
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(config.port, config.host, () => {
    log.info("fest listening", describeConfig(config));
    // Printed on stdout so it is greppable without the log envelope.
    process.stdout.write(
      `fest: http://${config.host}:${config.port}  ->  ${config.upstreamBaseUrl}\n` +
        `point Claude Code at it with:\n` +
        `  ANTHROPIC_BASE_URL=http://${config.host}:${config.port}/t/<your-token>\n` +
        `and do NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (either disables your subscription)\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`fest: failed to start: ${String(err)}\n`);
  process.exit(1);
});
