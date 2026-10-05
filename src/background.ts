import type { Logger } from "./logger.js";

/**
 * Fire-and-forget with bookkeeping. The webhook answers 200 right away and
 * the work runs here. drain() lets tests wait for it and lets the server
 * finish in-flight work on SIGTERM instead of dropping it.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  run(label: string, task: () => Promise<unknown>): void {
    const p: Promise<void> = Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (err: unknown) => {
          this.logger.error("background.failed", { label, error: describe(err) });
        },
      )
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  get size(): number {
    return this.pending.size;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

export function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
