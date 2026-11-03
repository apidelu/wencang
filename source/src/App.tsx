"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronDown, CircleHelp, FileText, FolderOpen, Image as ImageIcon, Link2, LoaderCircle, RotateCcw, Save, Settings2, ShieldCheck, Sparkles, Type, Upload, X, Trash2, Menu, ClipboardPaste, Clock3, ArrowUpRight, CheckCheck } from "lucide-react";
import { Article, Settings, defaultSettings, sampleArticle, cleanHtml, parseArticle, textHtml, articleCss, printDocument, safeLink } from "./article";
import BatchImport from "./BatchImport";
import { pdfFilename, pdfFilenames, createPdfZip, inlinePrintImageSources } from "./pdf-files";
import { preparePrintImages, type PrintImageFailure } from "./print-images";
type Draft = { id: string; savedAt: string; article: Article; settings: Settings };
type Tab = "batch" | "link" | "paste" | "file";
const STORAGE = "wencang-drafts-v1";
function Toggle({ value, onChange, label, detail }: { value: boolean; onChange: (b: boolean) => void; label: string; detail?: string }) {
  return <div className="toggle-row"><div><span>{label}</span>{detail && <small>{detail}</small>}</div><button type="button" className={`toggle ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}><span /></button></div>;
}
export default function Home() {
  const localFile = window.location.protocol === "file:";
  const [tab, setTab] = useState<Tab>(localFile ? "paste" : "batch"), [url, setUrl] = useState("");
  const [article, setArticle] = useState<Article>(sampleArticle), [settings, setSettings] = useState<Settings>(defaultSettings);
  const [busy, setBusy] = useState(false), [printing, setPrinting] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [exportProgress, setExportProgress] = useState("");
  const [exportDownload, setExportDownload] = useState<{url:string;name:string;count:number}|null>(null);
  useEffect(()=>()=>{if(exportDownload)URL.revokeObjectURL(exportDownload.url);},[exportDownload]);
  const [imageFailures, setImageFailures] = useState<PrintImageFailure[]>([]);
  const printController = useRef<AbortController | null>(null);
  const [pasteTitle, setPasteTitle] = useState(""), [pasteAuthor, setPasteAuthor] = useState(""), [pasteText, setPasteText] = useState(""), [pasteHtml, setPasteHtml] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]), [dialog, setDialog] = useState<"help" | "drafts" | "edit" | null>(null);
  const [draftTitle, setDraftTitle] = useState(""), [draftAuthor, setDraftAuthor] = useState(""), [draftDate, setDraftDate] = useState(""), [draftSource, setDraftSource] = useState("");
  const [dragging, setDragging] = useState(false), [mobileNav, setMobileNav] = useState(false), [imageErrors, setImageErrors] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null), modal = useRef<HTMLDialogElement>(null), requestSeq = useRef(0);
  useEffect(() => { try { const d = JSON.parse(localStorage.getItem(STORAGE) || "[]"); if (Array.isArray(d)) setDrafts(d.filter(v => v?.article?.title && typeof v?.article?.html === "string" && v.settings).slice(0, 8)); } catch {} }, []);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => { if (dialog) modal.current?.showModal(); else modal.current?.close(); }, [dialog]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(s => ({ ...s, [key]: value }));
  const switchTab = (t: Tab) => { requestSeq.current++; setBusy(false); setTab(t); setError(""); };
  const accept = (a: Article) => { setArticle(a); setImageErrors(0); setError(""); setNotice(a.sample ? "已载入示例，可以试试不同的排版。" : "文章已导入，可以预览并调整排版。"); };
  async function importLink(e: React.FormEvent) {
    e.preventDefault(); setError(""); if (localFile) {setError("直接打开 HTML 时无法读取公众号链接。请关闭本页，双击同一文件夹中的 Start.cmd 启动本地服务；首次使用需安装 Node.js 22 或以上版本。"); return;} const value = url.trim();
    try { const u = new URL(value); if (u.hostname !== "mp.weixin.qq.com" || !["http:", "https:"].includes(u.protocol)) throw new Error(); } catch { setError("请粘贴完整的微信公众号文章链接，例如 https://mp.weixin.qq.com/s/…"); return; }
    const seq = ++requestSeq.current; setBusy(true);
    try { const response = await fetch("/api/article", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({url:value}), signal: AbortSignal.timeout(25000) }); const data = await response.json() as {error?: string; html: string; source: string}; if (seq !== requestSeq.current) return; if (!response.ok) throw new Error(data.error || "暂时无法读取文章。"); accept(parseArticle(data.html, data.source)); }
    catch (e) { if (seq === requestSeq.current) setError((e as Error).name === "TimeoutError" ? "读取超时，请改用粘贴正文导入。" : (e as Error).message); }
    finally { if (seq === requestSeq.current) setBusy(false); }
  }
  function importPaste(e: React.FormEvent) {
    e.preventDefault(); if (!pasteText.trim() && !pasteHtml) { setError("请先粘贴文章正文。"); return; }
    if (pasteText.length > 1_000_000 || pasteHtml.length > 6_000_000) { setError("正文过长，请分篇导入。"); return; }
    const html = pasteHtml ? cleanHtml(pasteHtml) : textHtml(pasteText);
    if (!html.trim()) { setError("没有找到可导入的文字或图片，请重新复制正文。"); return; }
    accept({title:pasteTitle.trim() || "未命名文章", author:pasteAuthor.trim(), date:"", html, source:""});
  }
  async function importFile(file?: File) {
    if (!file) return; setError("");
    if (!/\.(html?|txt)$/i.test(file.name)) { setError("请选择 .html、.htm 或 .txt 文件。"); return; }
    if (file.size > 6_000_000) { setError("文件超过 6 MB，请选择较小的文件。"); return; }
    try { const raw = await file.text(); if (/\.txt$/i.test(file.name)) { if (!raw.trim()) throw new Error("文件内容为空。"); accept({title:file.name.replace(/\.txt$/i,""),author:"",date:"",source:"",html:textHtml(raw)}); } else accept(parseArticle(raw, "", file.name)); } catch(e) { setError((e as Error).message); }
    if (fileInput.current) fileInput.current.value = "";
  }
  function saveDraft() {
    const draft: Draft = {id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`, savedAt: new Date().toISOString(), article, settings};
    const next = [draft, ...drafts.filter(d => d.article.title !== article.title || d.article.source !== article.source)].slice(0, 8);
    try { localStorage.setItem(STORAGE, JSON.stringify(next)); setDrafts(next); setNotice("草稿已保存到当前浏览器。"); } catch { setNotice("浏览器存储空间不足，草稿未保存。请导出 PDF 留存。"); }
  }
  function removeDraft(id: string) { const next = drafts.filter(d => d.id !== id); try { localStorage.setItem(STORAGE, JSON.stringify(next)); setDrafts(next); } catch { setNotice("无法删除，请检查浏览器的存储权限。"); } }
  async function exportPdf() {
    if (printController.current) return;
    const abort = new AbortController(); printController.current = abort;
    const articles = [article].map(a => ({...a, html:cleanHtml(a.html)}));
    const exportTitle = pdfFilename(articles[0]).replace(/\.pdf$/i, "");
    setPrinting(true); setError(""); setImageFailures([]); setExportProgress("正在检查文章图片…");
    let frame: HTMLIFrameElement | null = null, release = () => {}, handedToPrint = false;
    const oldTitle = document.title;
    const cleanup = () => {frame?.remove(); release();};
    try {
      let readyArticles = articles;
      if (settings.images) {
        const prepared = await preparePrintImages(articles, {signal:abort.signal, onProgress:(done,total)=>setExportProgress(`正在准备图片 ${done} / ${total}，请保持本页打开…`)});
        readyArticles = prepared.articles; release = prepared.release; setImageFailures(prepared.failures);
        const failed = prepared.failures.reduce((n,item)=>n+item.count,0);
        if (failed) {
          const reasons = [...new Set(prepared.failures.map(item=>item.reason))].slice(0,3).join("\n");
          if (!window.confirm(`${failed} 张图片未成功加载：\n${reasons}\n\n是否继续导出？缺图处会标明，点击「取消」可留在页面查看原因。`)) return;
        }
      } else {
        readyArticles = articles.map(a => {const doc=new DOMParser().parseFromString(a.html,"text/html");doc.querySelectorAll("img").forEach(img=>img.remove());return {...a,html:doc.body.innerHTML};});
      }
      abort.signal.throwIfAborted(); setExportProgress("图片已处理，正在生成打印页面…");
      frame = document.createElement("iframe"); frame.title = "PDF 打印文档"; frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:1100px;border:0;"; document.body.appendChild(frame);
      const doc = frame.contentDocument, win = frame.contentWindow;
      if (!doc || !win) throw new Error("浏览器无法打开打印窗口，请换用桌面版 Chrome 或 Edge。");
      doc.open(); doc.write(printDocument(readyArticles[0], settings)); doc.close(); doc.title=exportTitle;
      await Promise.all(Array.from(doc.images).filter(img=>img.hasAttribute("src")).map(img=>img.decode()));
      await doc.fonts.ready; abort.signal.throwIfAborted();
      document.title = exportTitle;
      win.addEventListener("afterprint", cleanup, {once:true});
      win.focus(); win.print(); handedToPrint = true;
      window.setTimeout(cleanup, 600000);
      setNotice("已打开打印窗口，请选择「另存为 PDF」完成保存。");
    } catch(e) {
      if (abort.signal.aborted) setNotice("已取消准备图片，文章清单已保留。");
      else setError((e as Error).message || "图片处理失败，请重试。");
    } finally {
      document.title = oldTitle; setPrinting(false); setExportProgress(""); printController.current = null;
      if (!handedToPrint) cleanup();
    }
  }
  async function exportSeparatePdfs(input: Article[]) {
    if (printController.current || !input.length) return;
    if (localFile) {setError("分别生成 PDF 请使用 Start.cmd 启动本地服务。");return;}
    const abort = new AbortController(); printController.current=abort;
    setPrinting(true);setError("");setImageFailures([]);setExportProgress("正在准备分别导出…");
    const names=pdfFilenames(input), files:Array<{name:string;bytes:Uint8Array}>=[];
    let release=()=>{}, problem="";
    try {
      let ready=input.map(a=>({...a,html:cleanHtml(a.html)}));
      if(settings.images) {
        const prepared=await preparePrintImages(ready,{signal:abort.signal,onProgress:(done,total)=>setExportProgress(`正在准备图片 ${done} / ${total}，请保持本页打开…`)});
        ready=prepared.articles;release=prepared.release;setImageFailures(prepared.failures);
        const failed=prepared.failures.reduce((sum,f)=>sum+f.count,0);
        if(failed && !window.confirm(`${failed} 张图片未成功加载：\n${[...new Set(prepared.failures.map(f=>f.reason))].slice(0,3).join("\n")}\n\n是否仍要分别导出 PDF？缺图处会标明。`))return;
      } else ready=ready.map(a=>{const t=document.createElement("template");t.innerHTML=a.html;t.content.querySelectorAll("img").forEach(img=>img.remove());return {...a,html:t.innerHTML};});
      for(let i=0;i<ready.length;i++) {
        abort.signal.throwIfAborted();setExportProgress(`正在生成独立 PDF ${i+1} / ${ready.length}：${ready[i].title}`);
        const embedded=await inlinePrintImageSources(ready[i]);
        abort.signal.throwIfAborted();
        const response=await fetch("/api/pdf",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({html:printDocument(embedded,settings)}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(70000)])});
        if(!response.ok) {
          let message=`PDF 生成失败（HTTP ${response.status}）。`;
          try{const data=await response.json();if(typeof data.error==="string")message=data.error;}catch{}
          throw new Error(message);
        }
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-")throw new Error("本地服务未返回有效的 PDF，请关闭旧启动窗口并用新版 Start.cmd 重启。");
        files.push({name:names[i],bytes});
      }
    } catch(e) {
      problem=abort.signal.aborted?"已停止分别导出。":(e as Error).name==="TimeoutError"?"PDF 生成超时，请减少本批文章数后重试。":(e as Error).message||"PDF 导出失败。";
    } finally {
      release();printController.current=null;setPrinting(false);setExportProgress("");
    }
    if(files.length) {
      const single=input.length===1;
      const bytes=single?files[0].bytes:createPdfZip(files);
      const blob=new Blob([new Uint8Array(bytes).buffer],{type:single?"application/pdf":"application/zip"});
      const url=URL.createObjectURL(blob), link=document.createElement("a");
      link.href=url;link.download=single?files[0].name:`文藏_独立PDF_${files.length}篇.zip`;setExportDownload({url,name:link.download,count:files.length});document.body.appendChild(link);link.click();link.remove();
      setNotice(single?`已生成 ${files[0].name}`:`已生成 ${files.length} 个独立 PDF，并打包下载。`);
    }
    if(problem)setError(`${problem}${files.length?` 已完成的 ${files.length} 篇已下载，其余 ${input.length-files.length} 篇尚未导出。`:""}`);
  }
  function editInfo() { setDraftTitle(article.title); setDraftAuthor(article.author); setDraftDate(article.date); setDraftSource(article.source); setDialog("edit"); }
  const characterCount = article.html.replace(/<[^>]*>/g, "").replace(/\s|&[a-z]+;/g, "").length, imageCount = (article.html.match(/<img\b/g) || []).length;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
      <a className="brand" href="./index.html" aria-label="文藏首页"><span className="brand-mark"><BookOpen size={23} strokeWidth={1.5}/></span><div><strong>文藏<span className="brand-dot">.</span></strong><small>WENCANG</small></div></a>
      <div className="sidebar-content"><div className="nav-caption">我的工作台</div><nav>
        <button className={!dialog || dialog === "edit" ? "nav-item active" : "nav-item"} onClick={() => {setDialog(null);setMobileNav(false);}}><FileText size={18}/><span>文章导出</span><span className="nav-indicator"/></button>
        <button className={dialog === "drafts" ? "nav-item active" : "nav-item"} onClick={() => {setDialog("drafts");setMobileNav(false);}}><FolderOpen size={18}/><span>本地草稿</span>{drafts.length > 0 && <span className="nav-count">{drafts.length}</span>}</button>
      </nav><div className="sidebar-rule"/><button className="nav-item" onClick={() => {setDialog("help");setMobileNav(false);}}><CircleHelp size={18}/><span>使用说明</span><ArrowUpRight size={14}/></button>
      <div className="sidebar-note"><div className="mini-pages"><span/><span/><span><BookOpen size={21}/></span></div><h3>好文章，慢慢读。</h3><p>把值得留存的文字，<br/>放进自己的阅读资料夹。</p><span className="note-line"/></div></div>
      <div className="local-note"><ShieldCheck size={16}/><span>草稿仅保存在当前浏览器</span></div><div className="sidebar-bottom"><span>为每一次重读而做</span><span>LOCAL 1.3</span></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumbs"><button className="mobile-menu icon-button" aria-label="打开菜单" onClick={() => setMobileNav(!mobileNav)}><Menu size={21}/></button><span>工作台</span><span className="slash">/</span><strong>文章导出</strong></div><button className="help-link" onClick={() => setDialog("help")}><CircleHelp size={15}/>导出指南<ArrowUpRight size={14}/></button></header>
      <main><section className="page-heading"><div><div className="eyebrow"><span/>让阅读，不止于收藏</div><h1>公众号文章转 <span>PDF</span></h1><p>留下好内容，整理成一份可以随时重读的文档。</p></div><div className="heading-actions"><div className="heading-badge"><CheckCheck size={17}/><span>清爽排版 · 文字可复制</span></div>{tab !== "batch" && <button className="primary-button heading-export" onClick={() => void exportPdf()} disabled={printing}>{printing ? <LoaderCircle size={16} className="spin"/> : <ArrowDownToLine size={16}/>}导出 PDF</button>}</div></section>
        <section className="local-banner"><ShieldCheck size={17}/><div><strong>{localFile ? "HTML 文件模式" : "本地运行模式"}</strong><span>{localFile ? "可导入 JSON 清单、粘贴图文和导出 PDF。提取 JSON 清单中的文章全文或单篇链接，请使用文件夹中的 Start.cmd。" : "程序在本机运行，无需登录 ChatGPT。JSON 批量提取、单篇链接与网络图片仍需联网。"}</span></div></section>
        <section className="import-card" aria-label="导入文章"><div className="import-tabs" role="tablist" aria-label="选择导入方式">
          <button id="tab-batch" role="tab" aria-selected={tab === "batch"} aria-controls="import-panel" className={tab === "batch" ? "selected" : ""} onClick={() => switchTab("batch")}><FolderOpen size={17}/>JSON 批量</button>
          <button id="tab-link" role="tab" aria-selected={tab === "link"} aria-controls="import-panel" className={tab === "link" ? "selected" : ""} onClick={() => switchTab("link")}><Link2 size={17}/>文章链接</button>
          <button id="tab-paste" role="tab" aria-selected={tab === "paste"} aria-controls="import-panel" className={tab === "paste" ? "selected" : ""} onClick={() => switchTab("paste")}><ClipboardPaste size={16}/>粘贴正文</button>
          <button id="tab-file" role="tab" aria-selected={tab === "file"} aria-controls="import-panel" className={tab === "file" ? "selected" : ""} onClick={() => switchTab("file")}><Upload size={16}/>导入文件</button>
          <button className="sample-link" onClick={() => {requestSeq.current++;setBusy(false);accept(sampleArticle);}}><Sparkles size={14}/>试试示例<ArrowUpRight size={13}/></button>
        </div><div className="import-content" id="import-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <div hidden={tab !== "batch"}><BatchImport printing={printing} onPreview={accept} onExport={exportSeparatePdfs} onNotice={setNotice}/></div>
          {tab === "link" && <form onSubmit={importLink}><div className="link-input-row"><div className="link-field"><Link2 size={19}/><input aria-label="微信公众号文章链接" placeholder="粘贴微信公众号文章链接，https://mp.weixin.qq.com/s/…" value={url} onChange={e => setUrl(e.target.value)} maxLength={8000} disabled={busy}/>{url && <button type="button" className="clear-input" aria-label="清空链接" onClick={() => setUrl("")} disabled={busy}><X size={15}/></button>}</div><button className="primary-button import-button" disabled={busy} type="submit">{busy && <LoaderCircle size={17} className="spin"/>}{busy ? "正在读取" : "读取文章"}{!busy && <ArrowRight size={17}/>}</button></div><p className="input-hint"><ShieldCheck size={14}/>支持公开可访问的公众号文章；如遇微信验证，可切换为粘贴正文。</p></form>}
          {tab === "paste" && <form onSubmit={importPaste} className="paste-form"><div className="paste-fields"><input aria-label="粘贴文章标题" placeholder="文章标题" value={pasteTitle} maxLength={300} onChange={e => setPasteTitle(e.target.value)}/><input aria-label="粘贴文章来源" placeholder="公众号 / 作者（选填）" value={pasteAuthor} maxLength={100} onChange={e => setPasteAuthor(e.target.value)}/></div><textarea aria-label="文章正文" placeholder="从文章页面复制正文并粘贴到这里。复制的内容带有图片时，会一并尝试保留。" value={pasteText} onChange={e => {setPasteText(e.target.value);setPasteHtml("");}} onPaste={e => { const html = e.clipboardData.getData("text/html"); if (html && !pasteText.trim()) {e.preventDefault();setPasteText(e.clipboardData.getData("text/plain"));setPasteHtml(html);} }}/><div className="paste-bottom"><small>{pasteHtml ? "已保留剪贴板中的图文结构" : "支持纯文字与浏览器复制的图文内容"}</small><button className="primary-button" type="submit">生成预览<ArrowRight size={16}/></button></div></form>}
          {tab === "file" && <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={e => {e.preventDefault();setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={e => {e.preventDefault();setDragging(false);void importFile(e.dataTransfer.files[0]);}}><span className="upload-icon"><Upload size={23}/></span><div><strong>拖入已保存的网页文件</strong><p>支持 HTML、HTM、TXT，最大 6 MB</p></div><button className="secondary-button" onClick={() => fileInput.current?.click()}>选择文件</button><input ref={fileInput} type="file" hidden accept=".html,.htm,.txt" onChange={e => void importFile(e.target.files?.[0])}/></div>}
          {error && <div className="error-message" role="alert"><CircleHelp size={16}/><span>{error}</span>{tab === "link" && <button onClick={() => switchTab("paste")}>粘贴正文<ArrowRight size={14}/></button>}</div>}
        </div></section>
        {exportDownload && <div className="image-preparation"><Check size={18}/><span>已生成 {exportDownload.count} 个独立 PDF。若下载未开始，请点击右侧链接。</span><a className="text-button" href={exportDownload.url} download={exportDownload.name}>下载 {exportDownload.name.endsWith(".zip")?"ZIP":"PDF"}</a></div>}
        {exportProgress && <div className="image-preparation" role="status"><LoaderCircle size={18} className="spin"/><span>{exportProgress}</span><button className="text-button" onClick={()=>printController.current?.abort()}>停止导出</button></div>}
        {imageFailures.length>0 && <div className="image-failures" role="alert"><strong>{imageFailures.reduce((n,f)=>n+f.count,0)} 张图片未加载成功</strong><p>成功图片已缓存。可以再次点击导出重试，或查看以下失败原因。</p><ul>{[...new Set(imageFailures.map(f=>f.reason))].map(reason=><li key={reason}>{reason}</li>)}</ul><details><summary>查看失败图片地址</summary><ul>{imageFailures.map((f,i)=><li key={f.url}><a href={f.url} target="_blank" rel="noopener noreferrer">图片 {i+1}{f.count>1?`（引用 ${f.count} 次）`:""}</a>：{f.reason}</li>)}</ul></details></div>}
        <div className="editor-grid"><section className="preview-panel" aria-label="文章预览"><div className="preview-toolbar"><div><span className={`status-dot ${article.sample ? "sample" : ""}`}/><strong>文档预览</strong><span className="preview-label">{article.sample ? "示例文章" : "已导入"}</span></div><button onClick={editInfo} className="text-button"><Type size={14}/>编辑信息</button></div>
          <div className="preview-stage"><div className="paper-size-label"><span>{settings.paper}</span><span>实时排版预览</span></div><article className={`paper ${settings.font === "serif" ? "serif" : ""}`} style={{padding:`${settings.margin * 2.3}px ${settings.margin * 2.6}px`}}><style>{articleCss(settings)}</style><div className="paper-kicker"><span>{article.sample ? "WENCANG / 阅读示例" : "ARTICLE / 阅读存档"}</span><span className="paper-stamp"><BookOpen size={13}/></span></div><h2 className="article-title">{article.title}</h2>{settings.metadata && <div className="article-meta">{article.author && <span className="article-author">{article.author}</span>}{article.date && <span>{article.date}</span>}{!article.author && !article.date && <span>个人阅读存档</span>}</div>}<div className="article-divider"/><div className="article-body" onErrorCapture={e => {if ((e.target as HTMLElement).tagName === "IMG") setImageErrors(n => n + 1);}} dangerouslySetInnerHTML={{__html:article.html}}/>{settings.source && article.source && <div className="article-source">原文链接：<a href={safeLink(article.source)} target="_blank" rel="noopener noreferrer">{article.source}</a></div>}<div className="paper-end"><span/>END<span/></div></article></div>
          <div className="preview-footer"><span><FileText size={13}/>{characterCount.toLocaleString()} 字符<span className="dot-divider">·</span><ImageIcon size={13}/>{imageCount} 张图片</span><span>导出时自动分页</span></div>{imageErrors > 0 && settings.images && <p className="image-warning">部分图片未能加载，请在导出前检查。网页文件中的本地图片需要内嵌或使用可访问的网络地址。</p>}
        </section>
        <aside className="settings-panel"><section className="settings-card"><div className="settings-heading"><div><Settings2 size={17}/><h2>排版设置</h2></div><button aria-label="重置排版设置" title="重置排版" className="icon-button" onClick={() => {setSettings(defaultSettings);setNotice("排版设置已恢复默认。");}}><RotateCcw size={15}/></button></div>
          <div className="settings-section"><label className="field-label">阅读风格</label><div className="style-options"><button className={settings.font === "sans" ? "style-option active" : "style-option"} onClick={() => update("font","sans")}><span className="style-letter sans">Aa</span><span>简约阅读</span>{settings.font === "sans" && <Check size={12}/>}</button><button className={settings.font === "serif" ? "style-option active" : "style-option"} onClick={() => update("font","serif")}><span className="style-letter serif">Aa</span><span>经典宋体</span>{settings.font === "serif" && <Check size={12}/>}</button></div></div>
          <div className="settings-section"><label className="field-label" htmlFor="paper-select">纸张尺寸</label><div className="select-wrap"><select id="paper-select" value={settings.paper} onChange={e => update("paper",e.target.value as Settings["paper"])}><option value="A4">A4 · 210 × 297 mm</option><option value="A5">A5 · 148 × 210 mm</option><option value="Letter">Letter · 216 × 279 mm</option></select><ChevronDown size={14}/></div><div className="slider-label"><label htmlFor="font-size">正文字号</label><span>{settings.size}<small> px</small></span></div><div className="range-line"><span className="range-small">A</span><input type="range" id="font-size" min="12" max="20" value={settings.size} onChange={e => update("size",Number(e.target.value))}/><span className="range-large">A</span></div><div className="slider-label"><label htmlFor="line-height">行间距</label><span>{settings.spacing.toFixed(1)}<small> 倍</small></span></div><input type="range" id="line-height" min="1.4" max="2.4" step="0.1" value={settings.spacing} onChange={e => update("spacing",Number(e.target.value))}/><label className="field-label margin-label">页边距</label><div className="segmented">{[{v:12,t:"紧凑"},{v:20,t:"标准"},{v:28,t:"宽松"}].map(x => <button key={x.v} className={settings.margin === x.v ? "active" : ""} onClick={() => update("margin",x.v)}>{x.t}</button>)}</div></div>
          <div className="settings-section toggles"><Toggle label="保留文章图片" value={settings.images} onChange={v => update("images",v)}/><Toggle label="显示作者与日期" value={settings.metadata} onChange={v => update("metadata",v)}/><Toggle label="附上原文链接" detail="在文末保留文章来源" value={settings.source} onChange={v => update("source",v)}/></div>
          <div className="export-section"><button className="export-button" onClick={() => void exportPdf()} disabled={printing}>{printing ? <LoaderCircle size={18} className="spin"/> : <ArrowDownToLine size={18}/>}<span>{printing ? "正在准备文档…" : "导出当前预览 PDF"}</span><ArrowUpRight size={17}/></button><p>在打印窗口中选择「另存为 PDF」</p><button className="save-button" onClick={saveDraft}><Save size={15}/>保存草稿</button></div>
        </section><div className="tip-card"><span><Sparkles size={16}/></span><div><h3>留一点阅读的呼吸感</h3><p>长文试试 16 px 字号和宽松页边距，重读时会更轻松。</p></div></div></aside></div>
        <footer className="workspace-footer"><span>一篇文章，一份长久的收藏。</span><span>仅供个人阅读存档，请尊重原作者版权。</span></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><Check size={16}/><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={14}/></button></div>}
    <dialog ref={modal} className="modal" onCancel={() => setDialog(null)} onClick={e => {if(e.target === modal.current) setDialog(null);}}><div className="modal-header"><div><span className="eyebrow">WENCANG / {dialog === "drafts" ? "DRAFTS" : dialog === "edit" ? "ARTICLE" : "GUIDE"}</span><h2>{dialog === "drafts" ? "本地草稿" : dialog === "edit" ? "编辑文章信息" : "把文章，变成一份 PDF"}</h2></div><button aria-label="关闭弹窗" className="icon-button" onClick={() => setDialog(null)}><X size={20}/></button></div>
      {dialog === "help" && <div className="help-body"><div className="help-step"><b>01</b><div><h3>导入你想留存的文章</h3><p>批量处理请选择「JSON 批量」，导入 articles.json，勾选文章后提取正文，再分别导出。每篇生成一个 PDF，文件名为“发布日期_文章标题.pdf”；多篇会打包成 ZIP 下载。JSON 的摘要不代替全文；提取失败项不会导出。单篇处理可粘贴微信公众号文章链接并点击「读取文章」。如微信要求验证或链接不可访问，请从原页面复制正文，切换到「粘贴正文」。也可以导入已保存的 HTML 或 TXT 文件。</p></div></div><div className="help-step"><b>02</b><div><h3>调整成适合自己的排版</h3><p>选择字体、纸张、字号与页边距，按需保留图片、作者和原文链接。预览连续展示正文，实际页数由打印排版决定。音视频与互动组件不会导入；部分复杂样式会简化。</p></div></div><div className="help-step"><b>03</b><div><h3>分别下载，或保存单篇预览</h3><p>批量导出由本机已安装的 Edge 或 Chrome 生成独立 PDF，无需逐篇操作打印窗口。日期缺失时文件名标为“日期不详”。单篇预览可点击「导出当前预览 PDF」，将打印目标选择为「另存为 PDF」。建议关闭浏览器自动添加的页眉和页脚，使用 100% 缩放，并核对纸张尺寸。文字可选择、复制和搜索。</p></div></div><div className="help-callout"><ShieldCheck size={20}/><div><strong>关于草稿与图片</strong><p>草稿保存在当前浏览器，最多 8 篇，清理浏览器数据会删除草稿。外部图片需要联网加载；本地 HTML 的相对图片路径无法直接导入。链接与公众号图片由本机服务读取，不需要微信账号或密码。双击 index.html 可以使用清单导入、正文导入和 PDF 导出；提取 JSON 所列全文及单篇链接需要先运行 Start.cmd。批量清单及提取结果仅暂存在当前页，刷新后需重新导入。</p></div></div></div>}
      {dialog === "drafts" && <div className="drafts-body"><p className="dialog-subtitle">保存在当前浏览器，最多 8 篇。重要文章请及时导出。</p>{drafts.length === 0 ? <div className="empty-state"><FolderOpen size={38} strokeWidth={1.2}/><h3>给下一次阅读留个位置</h3><p>导入文章后，点击「保存草稿」，就能在这里继续整理。</p><button className="primary-button" onClick={() => setDialog(null)}>开始整理<ArrowRight size={15}/></button></div> : drafts.map(d => <div className="draft-row" key={d.id}><span className="draft-icon"><FileText size={21}/></span><button className="draft-open" onClick={() => {accept({...d.article, html:cleanHtml(d.article.html), source:safeLink(d.article.source)});setSettings({...defaultSettings,...d.settings});setDialog(null);}}><strong>{d.article.title}</strong><small><Clock3 size={12}/>{new Date(d.savedAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}{d.article.sample ? " · 示例" : ""}</small></button><button className="icon-button delete-draft" aria-label={`删除草稿：${d.article.title}`} onClick={() => removeDraft(d.id)}><Trash2 size={16}/></button></div>)}</div>}
      {dialog === "edit" && <form className="edit-form" onSubmit={e => {e.preventDefault();setArticle(a => ({...a,title:draftTitle.trim() || "未命名文章",author:draftAuthor.trim(),date:draftDate.trim(),source:safeLink(draftSource.trim())}));setDialog(null);setNotice("文章信息已更新。");}}><label>文章标题<input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} maxLength={300} required/></label><label>公众号 / 作者<input value={draftAuthor} onChange={e => setDraftAuthor(e.target.value)} maxLength={100}/></label><label>发布日期<input value={draftDate} onChange={e => setDraftDate(e.target.value)} placeholder="例如：2026-11-03" maxLength={50}/></label><label>原文链接<input type="url" value={draftSource} onChange={e => setDraftSource(e.target.value)} placeholder="https://mp.weixin.qq.com/s/…"/></label><button className="primary-button" type="submit">保存信息<Check size={15}/></button></form>}
    </dialog>
  </div>;
}
