import assert from "node:assert/strict";
import test from "node:test";
import { runBatchExtraction, waitForBatch } from "../source/src/batch-runner.ts";

const article = title => ({ title, author: "测试账号", date: "2026-01-01", html: "<p>全文</p>", source: "https://mp.weixin.qq.com/s/test" });
const entry = (id, extra = {}) => ({ id, title: id, url: `https://mp.weixin.qq.com/s/${id}`, author: "", date: "", status: "pending", selected: true, ...extra });
const noWait = async () => {};
function track(initial) {
  let rows = initial;
  const events = [];
  return {
    get rows() { return rows; }, events,
    onUpdate(id, patch) {
      events.push([id, patch.status]);
      rows = rows.map(row => row.id === id ? { ...row, ...patch } : row);
    },
  };
}

test("partial failures continue sequentially and leave ready articles unchanged", async () => {
  const ready = entry("ready", { status: "success", article: article("ready") });
  const input = [ready, entry("one"), entry("bad"), entry("two"), entry("invalid", { url: "", status: "error" })];
  const state = track(input), calls = [];
  let inFlight = 0;
  const result = await runBatchExtraction(input, {
    signal: new AbortController().signal,
    wait: noWait,
    onUpdate: state.onUpdate,
    async loadArticle(row) {
      calls.push(row.id);
      assert.equal(++inFlight, 1);
      await Promise.resolve();
      inFlight--;
      if (row.id === "bad") throw new Error("正文不可读取");
      return article(row.id);
    },
  });
  assert.deepEqual(result, { successes: 2, failures: 1, stopped: false });
  assert.deepEqual(calls, ["one", "bad", "two"]);
  assert.deepEqual(state.events, [["one", "loading"], ["one", "success"], ["bad", "loading"], ["bad", "error"], ["two", "loading"], ["two", "success"]]);
  assert.equal(state.rows[0].article, ready.article);
  assert.equal(state.rows[2].error, "正文不可读取");
  assert.equal(state.rows[3].article.title, "two");
  assert.equal(input[1].status, "pending", "input is not mutated");
});

test("stop during fetch resets the active row and never fetches the next row", async () => {
  const abort = new AbortController();
  const input = [entry("one"), entry("stop"), entry("later")], state = track(input), calls = [];
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const running = runBatchExtraction(input, {
    signal: abort.signal, wait: noWait, onUpdate: state.onUpdate,
    async loadArticle(row, signal) {
      calls.push(row.id);
      if (row.id === "stop") {
        started();
        return await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return article(row.id);
    },
  });
  await startedPromise;
  abort.abort();
  assert.deepEqual(await running, { successes: 1, failures: 0, stopped: true });
  assert.deepEqual(calls, ["one", "stop"]);
  assert.deepEqual(state.rows.map(row => row.status), ["success", "pending", "pending"]);
  assert.equal(state.rows[0].article.title, "one");
  assert.equal(state.rows[1].error, undefined);
});

test("retry only reads unfinished entries and preserves the successful result", async () => {
  const ready = entry("ready", { status: "success", article: article("ready") });
  const input = [ready, entry("retry", { status: "error", error: "前次失败" }), entry("pending")];
  const state = track(input), calls = [];
  const result = await runBatchExtraction(input, {
    signal: new AbortController().signal, wait: noWait, onUpdate: state.onUpdate,
    async loadArticle(row) { calls.push(row.id); return article(row.id); },
  });
  assert.deepEqual(result, { successes: 2, failures: 0, stopped: false });
  assert.deepEqual(calls, ["retry", "pending"]);
  assert.equal(state.rows[0].article, ready.article);
  assert.ok(state.rows.every(row => row.status === "success" && row.error === undefined));
});

test("cancellation discards a late successful response and an already stopped queue does no work", async () => {
  const abort = new AbortController(), input = [entry("late"), entry("next")], state = track(input);
  const result = await runBatchExtraction(input, {
    signal: abort.signal, wait: noWait, onUpdate: state.onUpdate,
    async loadArticle(row) { abort.abort(); return article(row.id); },
  });
  assert.deepEqual(result, { successes: 0, failures: 0, stopped: true });
  assert.deepEqual(state.events, [["late", "loading"], ["late", "pending"]]);
  const again = await runBatchExtraction(input, {
    signal: abort.signal, wait: noWait,
    onUpdate() { assert.fail("stopped queue must not update rows"); },
    async loadArticle() { assert.fail("stopped queue must not fetch"); },
  });
  assert.deepEqual(again, result);
});

test("stop interrupts the inter-entry delay while retaining completed entries", async () => {
  const abort = new AbortController(), state = track([entry("first"), entry("next")]), calls = [];
  let paused;
  const pausedPromise = new Promise(resolve => { paused = resolve; });
  const running = runBatchExtraction(state.rows, {
    signal: abort.signal, onUpdate: state.onUpdate,
    async loadArticle(row) { calls.push(row.id); return article(row.id); },
    wait(signal) { paused(); return waitForBatch(signal, 60_000); },
  });
  await pausedPromise;
  abort.abort();
  assert.deepEqual(await running, { successes: 1, failures: 0, stopped: true });
  assert.deepEqual(calls, ["first"]);
  assert.deepEqual(state.rows.map(row => row.status), ["success", "pending"]);
});

test("timeouts get a retry message and non-Error failures remain recoverable", async () => {
  const input = [entry("timeout"), entry("unknown")], state = track(input);
  const result = await runBatchExtraction(input, {
    signal: new AbortController().signal, wait: noWait, onUpdate: state.onUpdate,
    async loadArticle(row) { if (row.id === "timeout") throw new DOMException("expired", "TimeoutError"); throw null; },
  });
  assert.deepEqual(result, { successes: 0, failures: 2, stopped: false });
  assert.match(state.rows[0].error, /超时/);
  assert.equal(state.rows[1].error, "读取失败。");
});
