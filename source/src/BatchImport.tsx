"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, CircleHelp, ExternalLink, FileJson, FileText, LoaderCircle, Square, Upload, X } from "lucide-react";
import type { Article } from "./article";
import { parseArticle } from "./article";
import { parseBatchJson, type BatchEntry } from "./batch";
import { runBatchExtraction } from "./batch-runner";

export default function BatchImport({ onPreview, onExport, onNotice, printing }: {
  onPreview: (article: Article) => void;
  onExport: (articles: Article[]) => Promise<void>;
  onNotice: (message: string) => void;
  printing: boolean;
}) {
  const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [filename, setFilename] = useState("");
  const [account, setAccount] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [isFile, setIsFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const loadVersion = useRef(0);
  useEffect(() => {setIsFile(window.location.protocol === "file:");return () => {controller.current?.abort();loadVersion.current++;};}, []);

  async function importJson(file?: File) {
    if (!file || locked.current || importingRef.current || printing) return;
    const version = ++loadVersion.current;
    setError("");
    if (!/\.json$/i.test(file.name)) {setError("请选择文章清单 JSON 文件，例如 articles.json。");return;}
    if (file.size > 2_000_000) {setError("JSON 文件超过 2 MB，请拆分后导入。");return;}
    importingRef.current=true;setImporting(true);
    try {
      const result = parseBatchJson(await file.text());
      if (version !== loadVersion.current) return;
      setEntries(result.entries);setAccount(result.accountName);setWarnings(result.warnings);setFilename(file.name);
      onNotice(`已导入 ${result.entries.length} 条文章记录，请勾选后提取正文。`);
    } catch(e) {if(version === loadVersion.current)setError((e as Error).message);}
    finally {importingRef.current=false;setImporting(false);if(input.current)input.current.value="";}
  }

  async function extract(ids?: string[]) {
    if (locked.current || importingRef.current || printing) return;
    if (isFile) {setError("直接打开 HTML 只能读取 JSON 清单。提取正文请先双击 Start.cmd 启动本地服务。");return;}
    const work = entries.filter(e => e.url && e.status !== "success" && (ids ? ids.includes(e.id) : e.selected));
    if (!work.length) {onNotice("请先勾选需要提取正文的文章。");return;}
    const abort = new AbortController();controller.current=abort;locked.current=true;setRunning(true);setError("");
    try {
      const result = await runBatchExtraction(work, {
        signal: abort.signal,
        onUpdate: (id, patch) => setEntries(rows => rows.map(e => e.id === id ? {...e, ...patch} : e)),
        loadArticle: async (entry, signal) => {
          const response = await fetch("/api/article", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({url:entry.url}), signal:AbortSignal.any([signal, AbortSignal.timeout(25000)])});
          const data = await response.json() as {html?:string;source?:string;error?:string};
          if (!response.ok || typeof data.html !== "string") throw new Error(data.error || "未返回文章正文。");
          const parsed = parseArticle(data.html, data.source || entry.url);
          return {...parsed, title:parsed.title === "未命名文章" ? entry.title : parsed.title, author:parsed.author || entry.author, date:parsed.date || entry.date, source:entry.url};
        }
      });
      onNotice(result.stopped ? `已停止，本次已成功 ${result.successes} 篇，可继续提取。` : `本次提取完成：成功 ${result.successes} 篇，失败 ${result.failures} 篇。`);
    } finally {
      setEntries(rows=>rows.map(e=>e.status==="loading"?{...e,status:"pending",error:undefined}:e));
      controller.current=null;locked.current=false;setRunning(false);
    }
  }
  const selectable=entries.filter(e=>e.url);
  const selected=selectable.filter(e=>e.selected);
  const ready=selected.filter((e):e is BatchEntry & {article:Article}=>e.status==="success"&&!!e.article);
  const toRead=selected.filter(e=>e.url&&e.status!=="success");
  const successTotal=entries.filter(e=>e.status==="success").length;
  const completed=entries.filter(e=>e.status==="success"||e.status==="error").length;
  const allSelected=selectable.length>0&&selectable.every(e=>e.selected);
  return <section className="batch-panel" aria-label="JSON 批量导入">
    <div className={`drop-zone batch-drop ${dragging?"dragging":""}`} onDragOver={e=>{e.preventDefault();if(!running&&!importing&&!printing)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);void importJson(e.dataTransfer.files[0]);}}>
      <span className="upload-icon"><FileJson size={25}/></span><div><strong>{filename||"导入公众号文章清单"}</strong><p>{filename?`${account?account+" · ":""}${entries.length} 篇文章 · 已提取 ${successTotal} 篇正文`:"选择或拖入 articles.json，自动识别文章标题、日期与链接"}</p></div>
      <button className="secondary-button" disabled={running||importing||printing} onClick={()=>input.current?.click()}><Upload size={14}/>{filename?"更换 JSON":"选择 JSON 文件"}</button><input aria-label="JSON 文章清单文件" ref={input} type="file" hidden accept=".json,application/json" onChange={e=>void importJson(e.target.files?.[0])}/>
    </div>
    <p className="batch-explanation"><CircleHelp size={14}/>{isFile?"HTML 文件模式可以导入清单；提取正文请使用 Start.cmd 启动。":"JSON 是文章清单，导入后还需要联网提取全文。支持最多 100 条，按原文件顺序排列。"}</p>
    {warnings.length>0&&<div className="batch-warning" role="status">{warnings.map((w,i)=><p key={i}>{w}</p>)}</div>}
    {error&&<div className="error-message" role="alert"><CircleHelp size={16}/><span>{error}</span></div>}
    {entries.length>0&&<>
      <div className="batch-actions"><label className="batch-select-all"><input type="checkbox" aria-label="全选文章" checked={allSelected} disabled={running||importing||printing} onChange={e=>setEntries(rows=>rows.map(r=>({...r,selected:!!r.url&&e.target.checked})))}/>全选<span>已选 {selected.length} 篇</span></label><div>{running?<button className="secondary-button stop-button" onClick={()=>controller.current?.abort()}><Square size={12}/>停止提取</button>:<button className="primary-button" disabled={!toRead.length||isFile||printing||importing} onClick={()=>void extract()}><ArrowDownToLine size={14}/>提取所选正文{toRead.length>0?`（${toRead.length}）`:""}</button>}</div></div>
      <div className="batch-progress" role="progressbar" aria-label="文章处理进度" aria-valuemin={0} aria-valuemax={entries.length} aria-valuenow={completed}><span style={{width:`${completed/entries.length*100}%`}}/></div>
      <div className="batch-list" role="list" aria-label="待导出文章">
        {entries.map((entry,index)=><div className={`batch-row ${entry.status}`} role="listitem" key={entry.id}>
          <input type="checkbox" aria-label={`选择文章：${entry.title}`} checked={entry.selected} disabled={running||importing||printing||!entry.url} onChange={e=>setEntries(rows=>rows.map(r=>r.id===entry.id?{...r,selected:e.target.checked}:r))}/><span className="batch-number">{String(index+1).padStart(2,"0")}</span>
          <div className="batch-row-main"><strong>{entry.article?.title||entry.title}</strong><div className="batch-row-meta"><span>{entry.date||"日期未提供"}</span>{entry.author&&<span>{entry.author}</span>}{entry.url&&<a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={`查看原文：${entry.title}`}>原文<ExternalLink size={10}/></a>}</div>{entry.error&&<p className="batch-row-error">{entry.error}</p>}</div>
          <div className="batch-row-side"><span className={`batch-state ${entry.status}`}>{entry.status==="loading"?<><LoaderCircle size={12} className="spin"/>提取中</>:entry.status==="success"?<><Check size={12}/>已就绪</>:entry.status==="error"?<><X size={12}/>未成功</>:"待提取"}</span>{entry.article&&<><button className="text-button" onClick={()=>onPreview(entry.article!)}><FileText size={12}/>预览</button><button className="text-button" disabled={running||printing||importing||isFile} onClick={()=>void onExport([entry.article!])}><ArrowDownToLine size={12}/>下载 PDF</button></>}{entry.status==="error"&&entry.url&&<button className="text-button" disabled={running||isFile||printing||importing} onClick={()=>void extract([entry.id])}>重试</button>}</div>
        </div>)}
      </div>
      <div className="batch-export"><div><strong>所选文章中，{ready.length} 篇可导出</strong><p>{selected.length-ready.length>0?`另外 ${selected.length-ready.length} 篇未成功提取，不会导出。`:"每篇独立 PDF，按“发布日期_文章标题”命名，多篇打包 ZIP 下载。"}</p><small>清单及正文暂存于本页，刷新或关闭页面后需要重新导入。</small></div><button className="export-button" disabled={!ready.length||running||printing||importing} onClick={()=>void onExport(ready.map(e=>e.article))}><ArrowDownToLine size={16}/>{printing?"准备导出…":`分别导出 PDF（${ready.length} 篇）`}</button></div>
    </>}
  </section>;
}
