// Local PDF conversion using an already installed Edge or Chrome. No npm dependencies.
import {access, mkdtemp, writeFile, readFile, stat, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

export const MAX_PDF_HTML_BYTES = 64_000_000;
export class PdfExportError extends Error {
  constructor(message, code, status = 500) {super(message);this.name='PdfExportError';this.code=code;this.status=status;}
}
const invalid = message => new PdfExportError(message, 'PDF_INVALID_HTML', 400);
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CSP = "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const allowedTags = new Set('html head body meta title style section div span h1 h2 h3 h4 h5 h6 p strong b em i u s br hr blockquote ul ol li a img figure figcaption table thead tbody tr th td pre code sup sub footer'.split(' '));
const voidTags = new Set(['meta','img','br','hr']);
function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if(entity[0]==='#') {const n=Number.parseInt(entity.slice(entity[1]?.toLowerCase()==='x'?2:1),entity[1]?.toLowerCase()==='x'?16:10);if(n<=0||n>0x10ffff||n>=0xd800&&n<=0xdfff)throw invalid('文档包含无效字符。');return String.fromCodePoint(n);}
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
  });
}
function safeCss(css) {
  const plain=css.replace(/\/\*[\s\S]*?\*\//g,'');
  if(/[\\<>]|(?:url|image-set|image|expression)\s*\(|@(?:import|font-face)|(?:https?|file|ftp|data):|\/\/|(?:behavior|-moz-binding)\s*:/i.test(plain)) throw invalid('PDF 样式不能引用外部资源。');
  return css;
}
/** Strictly accepts the app's small print-document vocabulary and reconstructs its attributes. */
export function preparePdfHtml(html) {
  if(typeof html!=='string'||!html.trim())throw invalid('没有收到需要导出的文档。');
  if(Buffer.byteLength(html)>MAX_PDF_HTML_BYTES)throw new PdfExportError('单篇文档超过 64 MB，请减少图片后重试。','PDF_TOO_LARGE',413);
  if(!/^\s*<!doctype\s+html\s*>/i.test(html))throw invalid('PDF 文档格式不正确，请重新导出。');
  if(/\0/.test(html))throw invalid('文档包含无效字符。');
  const source=html.replace(/^\s*<!doctype\s+html\s*>/i,'');
  let out='<!doctype html>',offset=0,match,htmlCount=0,headCount=0,bodyCount=0;
  const stack=[], tokens=/<[^>]*>/g;
  while((match=tokens.exec(source))) {
    const text=source.slice(offset,match.index), current=stack.at(-1);
    if(text.includes('<'))throw invalid('文档标签格式不正确。');
    if(current==='style')safeCss(text);
    out+=text;offset=tokens.lastIndex;
    const token=match[0], parsed=token.match(/^<(\/)?([a-z][a-z0-9]*)\b([\s\S]*?)>$/i);
    if(!parsed)throw invalid('PDF 文档包含不支持的内容。');
    const closing=!!parsed[1],tag=parsed[2].toLowerCase();
    if(!allowedTags.has(tag))throw invalid('PDF 文档包含脚本、嵌入内容或不支持的标签。');
    if(closing) {
      if(parsed[3].trim()||voidTags.has(tag)||stack.pop()!==tag)throw invalid('PDF 文档标签未正确闭合。');
      out+=`</${tag}>`;continue;
    }
    if(current==='style'||current==='title')throw invalid('PDF 文档标签格式不正确。');
    if(tag==='html'){htmlCount++;if(stack.length)throw invalid('PDF 文档结构不正确。');}
    if(tag==='head'){headCount++;if(current!=='html')throw invalid('PDF 文档结构不正确。');}
    if(tag==='body'){bodyCount++;if(current!=='html'||headCount!==1)throw invalid('PDF 文档结构不正确。');}
    if(['title','style','meta'].includes(tag)&&current!=='head')throw invalid('PDF 文档头部格式不正确。');
    const raw=parsed[3].replace(/\/$/,'');let pos=0,attrs='',seen=new Set();
    const attribute=/\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/igy;
    while(pos<raw.length) {
      if(!raw.slice(pos).trim())break;
      attribute.lastIndex=pos;const a=attribute.exec(raw);
      if(!a)throw invalid('PDF 文档属性格式不正确。');pos=attribute.lastIndex;
      const name=a[1].toLowerCase(),value=decode(a[2]??a[3]);
      if(seen.has(name))throw invalid('PDF 文档包含重复属性。');seen.add(name);
      let allowed=false;
      if(name==='class'||name==='id'){allowed=/^[a-zA-Z0-9 _-]*$/.test(value);}
      else if(name==='style'){allowed=/^text-align\s*:\s*(?:center|right|justify)\s*;?$/i.test(value);}
      else if(tag==='html'&&name==='lang'){allowed=/^[a-zA-Z-]+$/.test(value);}
      else if(tag==='meta'&&name==='charset'){allowed=/^utf-8$/i.test(value);}
      else if(tag==='img'&&name==='src'){allowed=/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value);}
      else if(tag==='img'&&name==='alt'){allowed=true;}
      else if(tag==='img'&&name==='loading'){allowed=value==='eager';}
      else if(tag==='img'&&name==='referrerpolicy'){allowed=value==='no-referrer';}
      else if(tag==='a'&&name==='href') {
        if(/^#[a-zA-Z0-9_-]+$/.test(value))allowed=true;
        else {try{const u=new URL(value);allowed=['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\u0000-\u0020]/.test(value);}catch{}}
      }
      else if(tag==='a'&&name==='target'){allowed=value==='_blank';}
      else if(tag==='a'&&name==='rel'){allowed=/^(?:noopener|noreferrer)(?:\s+(?:noopener|noreferrer))*$/.test(value);}
      else if(['td','th'].includes(tag)&&['colspan','rowspan'].includes(name)){allowed=/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=20;}
      if(!allowed)throw invalid('PDF 文档含外部资源、事件处理器或不支持的属性。');
      attrs+=` ${name}="${escape(value)}"`;
    }
    if(tag==='img'&&!seen.has('src'))throw invalid('PDF 图片尚未准备好。');
    if(tag==='meta'&&(!seen.has('charset')||seen.size!==1))throw invalid('PDF 文档不能包含跳转指令。');
    out+=`<${tag}${attrs}>`;
    if(tag==='head')out+=`<meta http-equiv="Content-Security-Policy" content="${escape(CSP)}">`;
    if(!voidTags.has(tag))stack.push(tag);
  }
  const tail=source.slice(offset);
  if(tail.includes('<')||stack.length||htmlCount!==1||headCount!==1||bodyCount!==1)throw invalid('PDF 文档结构不完整。');
  return out+tail;
}

export async function findInstalledBrowser({platform=process.platform,env=process.env,exists=async file=>{try{await access(file,constants.F_OK);return true;}catch{return false;}}}={}) {
  let candidates=[];
  if(platform==='win32') {
    const roots=[env.PROGRAMFILES,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(Boolean);
    const join=path.win32.join;
    candidates=[...roots.map(root=>join(root,'Microsoft','Edge','Application','msedge.exe')),...roots.map(root=>join(root,'Google','Chrome','Application','chrome.exe'))];
  } else if(platform==='darwin') candidates=['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  else candidates=['/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'];
  for(const candidate of [...new Set(candidates)])if(await exists(candidate))return candidate;
  throw new PdfExportError('未找到 Microsoft Edge 或 Google Chrome。请先安装其中一种浏览器，再重新启动文藏。','PDF_BROWSER_MISSING',503);
}

export function runBrowser(executable,args,{timeoutMs=45_000}={}) {
  return new Promise((resolve,reject)=>{
    let settled=false,timedOut=false,termination;
    const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:'ignore'});
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const stop=()=>new Promise(done=>{
      if(process.platform!=='win32'||!child.pid){child.kill('SIGKILL');done();return;}
      // Only terminate the process tree started for this conversion, never the user's browsing session.
      const killer=spawn(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
      let ended=false;const finishStop=()=>{if(ended)return;ended=true;clearTimeout(fallback);done();};
      const fallback=setTimeout(()=>{killer.kill();child.kill('SIGKILL');finishStop();},2000);
      killer.once('error',()=>{child.kill('SIGKILL');finishStop();});killer.once('close',finishStop);
    });
    const timer=setTimeout(()=>{timedOut=true;termination=stop();termination.finally(()=>finish(new PdfExportError('生成 PDF 超时，请减少单篇图片数量后重试。','PDF_TIMEOUT',504)));},timeoutMs);
    child.once('error',()=>finish(new PdfExportError('无法启动 PDF 转换浏览器，请检查 Edge 或 Chrome 是否可正常打开。','PDF_BROWSER_START',503)));
    child.once('close',async code=>{
      if(timedOut){await termination;finish(new PdfExportError('生成 PDF 超时，请减少单篇图片数量后重试。','PDF_TIMEOUT',504));}
      else finish(code===0?undefined:new PdfExportError('浏览器未能完成 PDF 转换，请关闭并重新启动文藏后重试。','PDF_RENDER_FAILED',502));
    });
  });
}

export function createPdfExporter({browserFinder=findInstalledBrowser,runner=runBrowser,tempRoot=os.tmpdir(),maxQueued=4}={}) {
  const queue=[];let active=false;
  const render=async html=>{
    const executable=await browserFinder();
    const temporary=await mkdtemp(path.join(tempRoot,'wencang-pdf-'));
    try {
      const input=path.join(temporary,'article.html'),output=path.join(temporary,'article.pdf');
      await writeFile(input,html,{encoding:'utf8',mode:0o600});
      const args=['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-sync','--disable-component-update','--no-pings',`--user-data-dir=${path.join(temporary,'profile')}`,'--no-pdf-header-footer','--timeout=30000',`--print-to-pdf=${output}`,pathToFileURL(input).href];
      await runner(executable,args,{timeoutMs:45_000});
      let info;
      try {info=await stat(output);}catch{throw new PdfExportError('浏览器没有生成 PDF 文件。请更新 Edge 或 Chrome 后重试。','PDF_OUTPUT_MISSING',502);}
      if(info.size>128_000_000)throw new PdfExportError('生成的 PDF 超过 128 MB，请减少图片后重试。','PDF_TOO_LARGE',413);
      const bytes=await readFile(output);
      if(bytes.length<8||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new PdfExportError('生成的文件不是有效 PDF，请重试。','PDF_INVALID_OUTPUT',502);
      return bytes;
    } finally {await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  };
  const drain=()=>{
    if(active||!queue.length)return;
    active=true;const job=queue.shift();
    render(job.html).then(job.resolve,job.reject).finally(()=>{active=false;drain();});
  };
  return html=>{
    let safe;
    try {safe=preparePdfHtml(html);}catch(error){return Promise.reject(error);}
    if(active&&queue.length>=maxQueued)return Promise.reject(new PdfExportError('PDF 导出队列已满，请等待当前任务完成后重试。','PDF_QUEUE_FULL',429));
    return new Promise((resolve,reject)=>{queue.push({html:safe,resolve,reject});drain();});
  };
}
