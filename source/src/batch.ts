import type { Article } from "./article";

export type BatchEntry = {
  id: string;
  title: string;
  url: string;
  author: string;
  date: string;
  status: "pending" | "loading" | "success" | "error";
  selected: boolean;
  error?: string;
  article?: Article;
};

export type BatchImport = { entries: BatchEntry[]; accountName: string; warnings: string[] };
export const MAX_BATCH_ENTRIES = 100;
export const MAX_BATCH_JSON_BYTES = 2_000_000;
let importSequence = 0;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function field(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

function articleUrl(value: unknown): { url: string; key: string } {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少文章链接，无法读取全文。");
  if (value.length > 8000) throw new Error("文章链接过长，请检查这一条记录。");
  let u: URL;
  try { u = new URL(value.trim()); } catch { throw new Error("文章链接不是有效的网址。"); }
  if (!["http:", "https:"].includes(u.protocol) || u.hostname !== "mp.weixin.qq.com" || u.username || u.password || (u.port && u.port !== "443")) {
    throw new Error("只支持 mp.weixin.qq.com 的公众号文章链接。");
  }
  if (u.pathname !== "/s" && !/^\/s\/[a-zA-Z0-9_-]+$/.test(u.pathname)) throw new Error("链接不是具体的公众号文章地址。");
  u.protocol = "https:";
  u.hash = "";
  let key: string;
  if (u.pathname === "/s") {
    const biz = u.searchParams.get("__biz"), mid = u.searchParams.get("mid");
    if (!biz || !mid) throw new Error("文章链接缺少 __biz 或 mid，请重新复制完整链接。");
    key = JSON.stringify([biz, mid, u.searchParams.get("idx") || "1", u.searchParams.get("sn") || ""]);
  } else key = u.pathname;
  return { url: u.href, key };
}

function publishedDate(row: Record<string, unknown>): string {
  let date: Date | undefined;
  if (typeof row.publishedAt === "string" && row.publishedAt.trim()) {
    const value = row.publishedAt.trim();
    // Preserve date-only values without interpreting them in the viewer's timezone.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))) return value;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) date = parsed;
  }
  if (!date && (typeof row.publishedAtUnix === "number" || typeof row.publishedAtUnix === "string")) {
    const seconds = Number(row.publishedAtUnix);
    if (Number.isFinite(seconds) && seconds > 0) {
      const parsed = new Date(seconds * 1000);
      if (Number.isFinite(parsed.getTime())) date = parsed;
    }
  }
  return date ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : "";
}

/** Import article metadata only. A digest or cover image is never a full article. */
export function parseBatchJson(raw: string): BatchImport {
  if (new TextEncoder().encode(raw).byteLength > MAX_BATCH_JSON_BYTES) throw new Error("JSON 文件超过 2 MB，请缩小文章清单后重试。");
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { throw new Error("JSON 格式不正确，请选择原始的 articles.json 文件。"); }
  const root = record(data);
  const rows = Array.isArray(data) ? data : root?.articles;
  if (!Array.isArray(rows)) throw new Error("没有找到 articles 文章数组，请选择包含文章清单的 JSON 文件。");
  if (!rows.length) throw new Error("JSON 中的文章清单为空。");
  if (rows.length > MAX_BATCH_ENTRIES) throw new Error(`一次最多导入 ${MAX_BATCH_ENTRIES} 篇，文件包含 ${rows.length} 条，请分批导入。`);
  const accountName = field(record(root?.account)?.name, 100);
  const warnings: string[] = [];
  if (typeof root?.count === "number" && root.count !== rows.length) warnings.push(`文件标记为 ${root.count} 篇，实际读取到 ${rows.length} 条记录，以实际清单为准。`);
  const entries: BatchEntry[] = [], seen = new Set<string>();
  const importId = `${Date.now().toString(36)}-${++importSequence}`;
  let duplicates = 0;
  rows.forEach((value, index) => {
    const row = record(value);
    const entry: BatchEntry = {
      id: `batch-${importId}-${index + 1}`,
      title: field(row?.title, 300) || `未命名文章（第 ${index + 1} 条）`,
      url: "", author: field(row?.author, 100) || accountName,
      date: row ? publishedDate(row) : "", status: "pending", selected: true,
    };
    try {
      if (!row) throw new Error("这一条不是文章对象，请检查 JSON 结构。");
      const parsed = articleUrl(row.url);
      if (seen.has(parsed.key)) { duplicates++; return; }
      seen.add(parsed.key);
      entry.url = parsed.url;
    } catch (error) {
      entry.status = "error";
      entry.selected = false;
      entry.error = (error as Error).message;
    }
    entries.push(entry);
  });
  if (duplicates) warnings.push(`已跳过 ${duplicates} 条重复文章链接，保留首次出现的顺序。`);
  const invalid = entries.filter(e => e.status === "error").length;
  if (invalid) warnings.push(`${invalid} 条记录无法读取，请查看对应行的原因；其余文章可以继续处理。`);
  return { entries, accountName, warnings };
}
