import type { Article } from "./article";

export type LoadedImageSource = { src: string; release?: () => void };
export type PrintImageFailure = { url: string; reason: string; count: number };
export type PrintImageOptions = {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  timeoutMs?: number;
  loadImageSource?: (url: string, signal: AbortSignal) => Promise<LoadedImageSource>;
};
const IMAGE_LIMIT = 10_000_000;
const IMAGE_MIME = /^image\/(?:png|jpeg|jpg|webp|gif|avif)(?:;|$)/i;

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return "图片读取超时。";
  return error instanceof Error ? error.message : "图片暂时无法读取。";
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("图片准备已取消。", "AbortError");
}
function decodeImage(src: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; img.onload = null; img.onerror = null;
      signal.removeEventListener("abort", abort);
      if (error) { img.removeAttribute("src"); reject(error); } else resolve();
    };
    const abort = () => finish(abortReason(signal));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    img.referrerPolicy = "no-referrer";
    img.onload = () => finish(img.naturalWidth > 0 ? undefined : new Error("图片没有可显示的内容。"));
    img.onerror = () => finish(new Error("图片无法解码或网络无法访问。"));
    img.src = src;
  });
}

/** Fetch a validated image once, then decode a private object URL before printing. */
export async function loadPrintImageSource(raw: string, signal: AbortSignal): Promise<LoadedImageSource> {
  if (raw.startsWith("data:image/")) { await decodeImage(raw, signal); return { src: raw }; }
  const url = new URL(raw, window.location.href);
  const localProxy = url.origin === window.location.origin && url.pathname === "/api/image";
  let response: Response;
  try {
    response = await fetch(url.href, { signal, referrerPolicy: "no-referrer", credentials: "same-origin" });
  } catch (error) {
    if (signal.aborted || localProxy || url.protocol !== "https:") throw error;
    // A browser may display an external image although its server disallows CORS reads.
    await decodeImage(url.href, signal);
    return { src: url.href };
  }
  if (!response.ok) {
    let detail = `图片读取失败（HTTP ${response.status}）。`;
    if (localProxy && response.headers.get("content-type")?.includes("application/json")) {
      try { const data: unknown = await response.json(); if (data && typeof data === "object" && "error" in data && typeof data.error === "string") detail = data.error; } catch {}
    }
    throw new Error(detail);
  }
  const type = response.headers.get("content-type") || "";
  if (!IMAGE_MIME.test(type)) { await response.body?.cancel(); throw new Error("图片地址未返回支持的图片格式。"); }
  if (Number(response.headers.get("content-length")) > IMAGE_LIMIT) { await response.body?.cancel(); throw new Error("单张图片超过 10 MB。"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片内容为空。");
  const chunks: BlobPart[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_LIMIT) { await reader.cancel(); throw new Error("单张图片超过 10 MB。"); }
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("图片内容为空。");
  const blob = new Blob(chunks, { type: type.split(";")[0].replace(/^image\/jpg$/i, "image/jpeg") });
  const src = URL.createObjectURL(blob);
  try { await decodeImage(src, signal); } catch (error) { URL.revokeObjectURL(src); throw error; }
  let released = false;
  return { src, release: () => { if (!released) {released = true; URL.revokeObjectURL(src);} } };
}

/** Queue time is excluded from each image's timeout. Duplicate references share one load. */
export async function prepareImageSources(urls: string[], options: PrintImageOptions = {}) {
  const counts = new Map<string, number>();
  for (const url of urls) counts.set(url, (counts.get(url) || 0) + 1);
  const queue = [...counts.keys()], sources = new Map<string, string>();
  const errors = new Map<string, string>(), releases: Array<() => void> = [];
  const loader = options.loadImageSource || loadPrintImageSource;
  let next = 0, done = 0, released = false;
  const release = () => { if (released) return; released = true; for (const cleanup of releases) cleanup(); };
  options.onProgress?.(0, queue.length);
  async function worker() {
    while (next < queue.length && !options.signal?.aborted) {
      const url = queue[next++];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("图片读取超时。", "TimeoutError")), Math.max(1, options.timeoutMs ?? 30000));
      const parentAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", parentAbort, { once: true });
      if (options.signal?.aborted) parentAbort();
      let removeAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const listener = () => reject(abortReason(controller.signal));
        if (controller.signal.aborted) listener();
        else {controller.signal.addEventListener("abort", listener, {once:true}); removeAbort=()=>controller.signal.removeEventListener("abort",listener);}
      });
      const loading = Promise.resolve().then(() => loader(url, controller.signal));
      // An injected/remote loader may ignore cancellation; release any late result too.
      void loading.then(result => { if (controller.signal.aborted) result.release?.(); }, () => {});
      try {
        const result = await Promise.race([loading, aborted]);
        controller.signal.throwIfAborted();
        sources.set(url, result.src);
        if (result.release) releases.push(result.release);
      } catch (error) { errors.set(url, errorText(error)); }
      finally {
        clearTimeout(timer); removeAbort(); options.signal?.removeEventListener("abort", parentAbort);
        done++; options.onProgress?.(done, queue.length);
      }
    }
  }
  const concurrency = Math.min(4, Math.max(1, Math.floor(options.concurrency || 4)));
  await Promise.all(Array.from({length: Math.min(concurrency, queue.length)}, worker));
  if (options.signal?.aborted) {release(); throw abortReason(options.signal);}
  const failures = queue.filter(url => errors.has(url)).map(url => ({url, reason: errors.get(url)!, count: counts.get(url)!}));
  return {sources, failures, release};
}

/** Input html must already be sanitized. Only generated image sources are introduced here. */
export async function preparePrintImages(articles: Article[], options: PrintImageOptions = {}) {
  // Template contents remain inert, so parsing cannot start a second download wave.
  const templates = articles.map(article => {
    const template = document.createElement("template");
    template.innerHTML = article.html;
    return template;
  });
  const images = templates.flatMap(template => Array.from(template.content.querySelectorAll("img")).map(img => {
    const url = img.getAttribute("src") || "";
    img.removeAttribute("src"); img.removeAttribute("srcset");
    return {img, url};
  }));
  const result = await prepareImageSources(images.filter(item => item.url).map(item => item.url), options);
  for (const {img, url} of images) {
    const source = result.sources.get(url);
    if (source) {img.src=source; img.loading="eager";}
    else {
      const placeholder = img.ownerDocument.createElement("p");
      placeholder.className="print-image-unavailable";
      placeholder.textContent=`[图片未能载入：${img.alt || "文章配图"}]`;
      img.replaceWith(placeholder);
    }
  }
  return {articles:articles.map((article, index)=>({...article,html:templates[index].innerHTML})), failures:result.failures, release:result.release};
}
