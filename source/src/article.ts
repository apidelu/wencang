export type Article = { title: string; author: string; date: string; html: string; source: string; sample?: boolean };
export type Settings = { paper: "A4" | "A5" | "Letter"; font: "sans" | "serif"; size: number; spacing: number; margin: number; images: boolean; metadata: boolean; source: boolean };
export const defaultSettings: Settings = { paper: "A4", font: "sans", size: 15, spacing: 1.9, margin: 20, images: true, metadata: true, source: true };
export const sampleArticle: Article = {
  title: "在城市的缝隙里，重新发现日常", author: "文藏编辑室", date: "2026-11-03", source: "", sample: true,
  html: `<p>我们总在赶往下一个目的地，却很少停下来，看一看每天经过的那条街。</p><p>树影落在旧建筑的墙面上，街角的咖啡店刚刚开门，熟悉的小路在晨光里显得有些不同。城市的故事，往往就藏在这些不起眼的日常里。</p><h2>01 / 把脚步放慢一点</h2><p>试着给自己一个没有目的地的下午。不看导航，不追赶时间，沿着一条喜欢的街道慢慢走。你可能会发现，一座城市最动人的部分，并不在那些被反复介绍的地标里。</p><blockquote>记录，是为了让那些值得记住的瞬间，<br>在日后仍然有迹可循。</blockquote><h2>02 / 留下一份可以重读的记录</h2><p>一篇让人有所触动的文章，一次关于城市的观察，一段想要反复读的文字——都值得拥有一个安静的去处。</p><p>将文章整理成 PDF，存进自己的阅读资料夹。保留文字、图片与出处，也保留当时读到它的那份心情。</p><h2>03 / 从收藏，到再次打开</h2><p>整理的意义，不在于拥有更多文件，而在于需要的时候，能够轻松找到。为文件起一个清楚的名字，按主题归档，隔一段时间再打开看看。</p><p>愿每一篇好文章，都有被再次阅读的机会。</p>`
};

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));

export function safeLink(raw: string): string {
  try { const u = new URL(raw); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : ""; } catch { return ""; }
}

export function safeImage(raw: string): string {
  if (raw.startsWith("/api/image?")) {
    const nested = new URL(raw, "https://local.invalid").searchParams.get("url") || "";
    try { const u = new URL(nested); if (["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(u.hostname) && u.protocol === "https:" && !u.username && !u.password && !u.port) return typeof window !== "undefined" && window.location.protocol === "file:" ? u.href : `/api/image?url=${encodeURIComponent(u.href)}`; } catch {}
    return "";
  }
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw) && raw.length < 6_000_000) return raw;
  const safe = safeLink(raw.startsWith("//") ? `https:${raw}` : raw);
  if (!safe) return "";
  const u = new URL(safe);
  if (["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(u.hostname)) {
    u.protocol = "https:";
    if (typeof window !== "undefined" && window.location.protocol === "file:") return u.href;
    return `/api/image?url=${encodeURIComponent(u.href)}`;
  }
  return u.protocol === "https:" ? safe : "";
}

// Construct a new, small DOM. No source markup or attributes are trusted.
export function cleanHtml(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const allowed = new Set(["p", "div", "section", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "br", "hr", "blockquote", "ul", "ol", "li", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "sup", "sub"]);
  const drop = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "svg", "math", "link", "meta", "noscript", "video", "audio"]);
  let count = 0;
  function walk(node: Node, depth = 0): string {
    if (++count > 30000 || depth > 100) return "";
    if (node.nodeType === 3) return escapeHtml(node.textContent || "");
    if (node.nodeType !== 1) return "";
    const el = node as HTMLElement, name = el.tagName.toLowerCase();
    if (drop.has(name) || ["js_pc_qr_code", "js_profile_qrcode", "js_tags", "js_related_container"].includes(el.id)) return "";
    if (name === "img") {
      const url = safeImage(el.getAttribute("data-src") || el.getAttribute("src") || "");
      if (!url) return "";
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(el.getAttribute("alt") || "文章配图")}" referrerpolicy="no-referrer" loading="eager" />`;
    }
    const inner = Array.from(el.childNodes).map(n => walk(n, depth + 1)).join("");
    if (!allowed.has(name)) return inner;
    if (["br", "hr"].includes(name)) return `<${name}>`;
    if (!inner.trim()) return "";
    let attrs = "";
    if (name === "a") {
      const href = safeLink(el.getAttribute("href") || "");
      if (href) attrs += ` href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"`;
    }
    if (["td", "th"].includes(name)) {
      for (const a of ["colspan", "rowspan"]) { const v = Number(el.getAttribute(a)); if (v > 1 && v <= 20) attrs += ` ${a}="${v}"`; }
    }
    const align = el.style.textAlign;
    if (["center", "right", "justify"].includes(align)) attrs += ` style="text-align:${align}"`;
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  return Array.from(doc.body.childNodes).map(n => walk(n)).join("");
}

export function parseArticle(raw: string, source = "", filename = ""): Article {
  if (raw.length > 6_000_000) throw new Error("文章文件过大，请选择 6 MB 以内的文件。");
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const wechat = doc.querySelector("#js_content");
  if (source && !wechat) throw new Error("微信暂未返回文章正文，可能需要在微信中验证。请打开原文复制内容，使用「粘贴正文」导入。");
  const text = (s: string) => doc.querySelector(s)?.textContent?.trim() || "";
  const meta = (s: string) => doc.querySelector(s)?.getAttribute("content")?.trim() || "";
  const title = text("#activity-name") || text(".rich_media_title") || meta('meta[property="og:title"]') || text("h1") || doc.title || filename.replace(/\.(html?|txt)$/i, "") || "未命名文章";
  const author = text("#js_name") || text(".rich_media_meta_nickname") || meta('meta[name="author"]');
  let date = text("#publish_time");
  if (!date) {
    const ct = raw.match(/\b(?:var\s+)?ct\s*=\s*["'](\d{10})["']/)?.[1];
    if (ct) date = new Date(Number(ct) * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  }
  const body = wechat || doc.querySelector("article") || doc.querySelector("main") || doc.body;
  if (!wechat && body.querySelector("h1")?.textContent?.trim() === title) body.querySelector("h1")?.remove();
  const html = cleanHtml(body.innerHTML);
  if (!html.trim()) throw new Error("没有找到可导入的正文，请粘贴文章内容后重试。");
  return { title: title.slice(0, 300), author: author.slice(0, 100), date: date.slice(0, 50), html, source };
}

export const textHtml = (text: string) => text.trim().split(/\n\s*\n|\n/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join("");
export function articleCss(s: Settings) {
  const family = s.font === "serif" ? '"Songti SC","SimSun","Noto Serif CJK SC",serif' : '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  return `.article-body{font-family:${family};font-size:${s.size}px;line-height:${s.spacing};color:#303631;overflow-wrap:anywhere}.article-body p{margin:0 0 1.1em}.article-body h1,.article-body h2,.article-body h3,.article-body h4{line-height:1.5;break-after:avoid;page-break-after:avoid}.article-body h2{font-size:1.18em;margin:1.8em 0 .9em;font-weight:650}.article-body h3{font-size:1.08em;margin:1.6em 0 .7em}.article-body a{color:#396753;text-decoration:underline;text-underline-offset:3px}.article-body blockquote{border-left:3px solid #9aaa91;margin:1.7em 0;padding:.3em 0 .3em 1.2em;color:#697363}.article-body img{${s.images ? "display:block;" : "display:none;"}max-width:100%;height:auto;margin:1.3em auto;object-fit:contain;break-inside:avoid;page-break-inside:avoid}.article-body figure{margin:1em 0;break-inside:avoid}.article-body figcaption{font-size:.85em;color:#777;text-align:center}.article-body table{border-collapse:collapse;width:100%;margin:1em 0;table-layout:fixed}.article-body td,.article-body th{border:1px solid #ddd;padding:7px;overflow-wrap:anywhere}.article-body tr{break-inside:avoid}.article-body pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3ef;padding:12px}.article-body ul,.article-body ol{padding-left:1.5em}.article-body hr{border:0;border-top:1px solid #ddd;margin:2em 0}.article-body p{orphans:3;widows:3}`;
}

export function printDocument(article: Article, s: Settings) {
  const title = escapeHtml(article.title), source = safeLink(article.source);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:${s.paper};margin:${s.margin}mm}*{box-sizing:border-box}body{margin:0;font-family:"PingFang SC","Microsoft YaHei",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:26px;line-height:1.55;margin:0 0 14px;break-after:avoid}.meta{font-size:12px;color:#777;margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid #ddd}.source{margin-top:32px;border-top:1px solid #ddd;padding-top:12px;color:#777;font-size:10px;overflow-wrap:anywhere}.source a{color:#777}.article-body img{max-height:${s.paper === "A5" ? 160 : 230}mm} ${articleCss(s)}</style></head><body><h1>${title}</h1>${s.metadata ? `<div class="meta">${[article.author, article.date].filter(Boolean).map(escapeHtml).join(" · ")}${article.sample ? " · 示例文章" : ""}</div>` : ""}<div class="article-body">${article.html}</div>${s.source && source ? `<footer class="source">原文链接：<a href="${escapeHtml(source)}">${escapeHtml(source)}</a></footer>` : ""}</body></html>`;
}

/** The caller must sanitize article.html before creating either print document. */
export function printCollectionDocument(articles: Article[], s: Settings): string {
  if (!articles.length) throw new Error("请先选择至少一篇已成功读取的文章。");
  if (articles.length === 1) return printDocument(articles[0], s);
  const base = printDocument(articles[0], s);
  const collectionTitle = `文章合集（${articles.length} 篇）`;
  const contents = `<section class="collection-contents"><h1>${collectionTitle}</h1><p class="collection-note">目录 · 按导入清单顺序排列</p><ol>${articles.map((article, index) => `<li><a href="#collection-article-${index + 1}">${escapeHtml(article.title)}</a>${s.metadata && article.date ? `<span>${escapeHtml(article.date)}</span>` : ""}</li>`).join("")}</ol></section>`;
  const body = articles.map((article, index) => {
    const document = printDocument(article, s);
    const content = document.slice(document.indexOf("<body>") + 6, document.lastIndexOf("</body>"));
    return `<section class="collection-article" id="collection-article-${index + 1}">${content}</section>`;
  }).join("");
  const style = `.collection-contents{break-after:page;page-break-after:always}.collection-note{font-size:12px;color:#777;margin:0 0 24px}.collection-contents ol{padding-left:1.6em;margin:0;line-height:1.8}.collection-contents li{padding:6px 0;break-inside:avoid}.collection-contents a{color:#303631;text-decoration:none;overflow-wrap:anywhere}.collection-contents li span{font-size:11px;color:#888;margin-left:12px}.collection-article+.collection-article{break-before:page;page-break-before:always}`;
  return base.slice(0, base.indexOf("<body>"))
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${collectionTitle}</title>`)
    .replace("</style>", `${style}</style>`)
    + `<body>${contents}${body}</body></html>`;
}
