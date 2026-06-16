/**
 * Human-readable tagged CLI logger for the examples/demos (separators, headers,
 * terminal banners). This is **intentionally** `console`-based for watchable demo
 * output — it is NOT the operational logger. Production/library code (actor, gateway,
 * drivers, state, telemetry, bootstrap) uses the structured JSON logger in
 * `./structured-logger`. Interactive HITL prompts (`./hitl`) are likewise console UI.
 *
 * Usage:
 *   const log = createLogger('Orchestrator');
 *   log.info('Step 1 — starting research');
 *   log.warn('No results returned');
 *   log.error('Fatal startup error', err);
 *   log.separator();          // ────────────────────────────────────────────
 *   log.header('STEP 2 — Writing');  // === STEP 2 — Writing ===
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, cause?: unknown): void;
  /** Prints a horizontal line of repeated `char` (default '─'), length `len` (default 60). */
  separator(char?: string, len?: number): void;
  /** Prints `=== <title> ===` surrounded by separator lines. */
  header(title: string, len?: number): void;
}

export function createLogger(tag: string): Logger {
  return {
    info(msg): void {
      console.log(`[${tag}] ${msg}`);
    },
    warn(msg): void {
      console.warn(`[${tag}] ${msg}`);
    },
    error(msg, cause?): void {
      if (cause !== undefined) {
        console.error(`[${tag}] ${msg}`, cause);
      } else {
        console.error(`[${tag}] ${msg}`);
      }
    },
    separator(char = "─", len = 60): void {
      console.log(char.repeat(len));
    },
    header(title, len = 60): void {
      const line = "=".repeat(len);
      console.log(`\n${line}`);
      console.log(` ${title}`);
      console.log(line);
    },
  };
}
