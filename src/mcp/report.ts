/**
 * The tool process's way of telling the console what just happened.
 *
 * The two processes are separate by necessity: TrueForge takes MCP servers by
 * remote URL only, so the tools run on 8792 and telephony holds the SSE
 * clients on 8791. There was no channel of any kind between them, which is
 * why every pane the tools should fill stayed empty on a live call.
 *
 * An authenticated HTTP POST rather than a unix socket. Both are loopback and
 * both work; HTTP wins on three counts here. It reuses the bearer-token check
 * both servers already carry rather than inventing filesystem-permission
 * ownership rules. It needs no framing protocol, where a stream socket needs
 * one and needs it to survive a reconnect mid-message. And a telephony
 * restart is an ordinary connection refusal to retry, not a vanished socket
 * file to re-watch. The cost is a token that has to reach both processes,
 * which `scripts/start.sh` handles.
 *
 * Two properties this has to hold, both tested:
 *
 *   A tool call must never fail, or wait, because nobody is watching.
 *   `report()` returns void, throws nothing, and awaits nothing. Delivery
 *   happens on a queue behind it.
 *
 *   Telephony restarting must not swallow the events that happened while it
 *   was down. The queue retries with backoff and keeps its order. It is
 *   bounded, because a call that runs for an hour against a console that
 *   never comes back cannot be allowed to grow this without limit; past the
 *   bound the OLDEST go, since what is on screen now matters more than what
 *   was on screen a minute ago, and `dropped()` counts them rather than
 *   losing them quietly.
 */

import type { ConsoleEventBody, ReportFrame } from '../console/events.ts';

export interface ReporterOptions {
  /** Where telephony's ingest route is. Loopback by default: this never
   *  needs to leave the machine. */
  url?: string | undefined;
  /** Shared bearer token. Without it the reporter is inert. */
  secret?: string | undefined;
  /** Frames kept while the far end is unreachable. */
  maxQueue?: number;
  /** Frames per POST. Telephony caps a request body at 64KB. */
  batchSize?: number;
  retryMs?: number;
  maxRetryMs?: number;
  /** How long one POST may take before it is treated as a failure. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULTS = {
  url: 'http://127.0.0.1:8791/ingest',
  maxQueue: 2000,
  batchSize: 50,
  retryMs: 500,
  maxRetryMs: 10_000,
  timeoutMs: 2_000,
};

export function createReporter(options: ReporterOptions = {}) {
  const url = options.url ?? DEFAULTS.url;
  const secret = options.secret;
  const maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
  const maxRetryMs = options.maxRetryMs ?? DEFAULTS.maxRetryMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const enabled = Boolean(secret);
  const queue: ReportFrame[] = [];
  let droppedCount = 0;
  let backoff = retryMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let kickQueued = false;

  async function post(frames: ReportFrame[]): Promise<boolean> {
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ frames }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Read the body even though nothing here wants it, so the connection
      // goes back to the pool instead of being held open by an unread stream.
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }

  function clearRetry(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function scheduleRetry(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      kick();
    }, backoff);
    backoff = Math.min(backoff * 2, maxRetryMs);
    // Never a reason to hold the process open. A console that missed the last
    // few events of a call is not worth a tool process that will not exit.
    timer.unref?.();
  }

  /** Sends as much of the queue as the far end will take. True when it
   *  emptied. */
  async function pump(): Promise<boolean> {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      if (!(await post(batch))) return false;
      queue.splice(0, batch.length);
      backoff = retryMs;
    }
    return true;
  }

  function kick(): void {
    if (!enabled || inFlight) return;
    clearRetry();
    const run = pump().then(
      (done) => { if (!done) scheduleRetry(); },
      () => { scheduleRetry(); },
    );
    inFlight = run.finally(() => { inFlight = null; });
    void inFlight.catch(() => undefined);
  }

  /**
   * Delivery starts on the next microtask, not inside `report()`.
   *
   * A fan-out reports five lanes in one synchronous burst. Kicking inside
   * `report()` would send the first on its own and batch the rest, which is
   * five round trips where one will do.
   */
  function scheduleKick(): void {
    if (kickQueued) return;
    kickQueued = true;
    queueMicrotask(() => {
      kickQueued = false;
      kick();
    });
  }

  return {
    /** Queues one event. Returns nothing, throws nothing, waits for nothing. */
    report(event: ConsoleEventBody): void {
      if (!enabled) return;
      queue.push({ at: now(), event });
      while (queue.length > maxQueue) {
        queue.shift();
        droppedCount++;
      }
      scheduleKick();
    },

    /** Waits for the delivery attempt already running, without forcing a
     *  retry. Test hook. */
    async settle(): Promise<void> {
      // Lets a kick queued by a `report()` in this same turn start first.
      await Promise.resolve();
      let running = inFlight;
      while (running) {
        await running.catch(() => undefined);
        running = inFlight;
      }
    },

    /** Drains the queue now rather than on the retry timer. Test hook. */
    async flush(): Promise<void> {
      clearRetry();
      await this.settle();
      if (!enabled) return;
      clearRetry();
      kick();
      await this.settle();
      clearRetry();
    },

    pending: (): number => queue.length,
    dropped: (): number => droppedCount,
    enabled: (): boolean => enabled,
    stop(): void {
      clearRetry();
    },
  };
}

/**
 * The process-wide reporter.
 *
 * Built at import, and inert with no `CONSOLE_INGEST_SECRET`: no timers, no
 * sockets, nothing for a test that imports this module to clean up.
 */
export const consoleReporter = createReporter({
  url: process.env.CONSOLE_INGEST_URL ?? DEFAULTS.url,
  secret: process.env.CONSOLE_INGEST_SECRET,
});

/** Reports one event to the operator console, if anyone is listening. */
export function reportEvent(event: ConsoleEventBody): void {
  consoleReporter.report(event);
}
