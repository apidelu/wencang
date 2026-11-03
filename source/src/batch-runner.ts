import type { Article } from "./article";
import type { BatchEntry } from "./batch";

export type BatchPatch = Pick<BatchEntry, "status"> & Partial<Pick<BatchEntry, "article" | "error">>;
export type BatchRunSummary = { successes: number; failures: number; stopped: boolean };
export type BatchRunOptions = {
  signal: AbortSignal;
  loadArticle: (entry: BatchEntry, signal: AbortSignal) => Promise<Article>;
  onUpdate: (id: string, patch: BatchPatch) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
};

/** Pause between requests; stopping also interrupts the pause immediately. */
export function waitForBatch(signal: AbortSignal, milliseconds = 800): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function failureMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const detail = error as { name?: unknown; message?: unknown };
    if (detail.name === "TimeoutError") return "读取超时，可稍后重试。";
    if (typeof detail.message === "string" && detail.message.trim()) return detail.message;
  }
  return "读取失败。";
}

/** Run an already-selected queue without mutating its entries or any ready articles. */
export async function runBatchExtraction(work: BatchEntry[], options: BatchRunOptions): Promise<BatchRunSummary> {
  const { signal, loadArticle, onUpdate, wait = waitForBatch } = options;
  const queue = work.filter(entry => entry.url && entry.status !== "success");
  let successes = 0, failures = 0;
  for (let index = 0; index < queue.length; index++) {
    if (signal.aborted) break;
    const entry = queue[index];
    onUpdate(entry.id, { status: "loading", error: undefined });
    let article: Article | undefined, failure: unknown, failed = false;
    try {
      if (!signal.aborted) article = await loadArticle(entry, signal);
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (signal.aborted) {
      onUpdate(entry.id, { status: "pending", error: undefined });
      break;
    }
    if (failed) {
      failures++;
      onUpdate(entry.id, { status: "error", error: failureMessage(failure) });
    } else {
      successes++;
      onUpdate(entry.id, { status: "success", article, error: undefined });
    }
    if (index < queue.length - 1 && !signal.aborted) {
      try { await wait(signal); } catch (error) { if (!signal.aborted) throw error; }
    }
  }
  return { successes, failures, stopped: signal.aborted };
}
