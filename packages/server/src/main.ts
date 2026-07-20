import { createApp } from "./app.js";
import { EnvironmentError, env } from "./env.js";
import { disconnect } from "./lib/db.js";

/**
 * Process entry point.
 *
 * Kept apart from `app.ts` so that tests can build the application without
 * binding a port, and so everything to do with the process lifecycle - signals,
 * shutdown, fatal errors - lives in exactly one place.
 */

function start(): void {
  let config;
  try {
    config = env();
  } catch (error) {
    if (error instanceof EnvironmentError) {
      // Misconfiguration is a startup failure, not a runtime surprise. Better
      // to refuse to boot than to run with a missing signing secret.
      console.error(error.message);
      console.error("\nCopy .env.example to .env and fill it in.");
      process.exit(1);
    }
    throw error;
  }

  const server = createApp().listen(config.PORT, () => {
    console.log(`Tessera API listening on http://localhost:${config.PORT} [${config.NODE_ENV}]`);
  });

  /**
   * Graceful shutdown.
   *
   * `server.close` stops accepting new connections and waits for in-flight
   * requests to finish, so a deploy does not sever a request mid-write. The
   * timer is the backstop: if something refuses to finish, exit anyway rather
   * than hang forever and be killed less politely.
   */
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received - shutting down`);

    const forceExit = setTimeout(() => {
      console.error("shutdown timed out - exiting anyway");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (error) => {
      if (error) console.error("error while closing the server", error);
      await disconnect();
      process.exit(error ? 1 : 0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A rejection nobody handled means state is unknown. Log loudly and let the
  // supervisor restart into a clean process rather than continue on guesswork.
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled promise rejection", reason);
    shutdown("unhandledRejection");
  });
}

start();
