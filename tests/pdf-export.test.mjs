import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {preparePdfHtml,findInstalledBrowser,createPdfExporter,PdfExportError,MAX_PDF_HTML_BYTES} from '../pdf-export.mjs';
import {createLocalServer} from '../server.mjs';
import {printDocument,defaultSettings} from '../source/src/article.ts';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const doc=body=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试</title><style>@page{size:A4;margin:18mm}body{font-family:"Microsoft YaHei",sans-serif}</style></head><body>${body}</body></html>`;
const valid=doc(`<p>中文 &lt;文字&gt;</p><img src="data:image/png;base64,${PNG}" alt="配图"><a href="https://mp.weixin.qq.com/s/a?x=1&amp;y=2">原文</a>`);
const PDF=Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

test('accepts real application printDocument with data pictures and preserves page CSS',()=>{
  const html=printDocument({title:'文章 & <标题>',author:'作者',date:'2026-11-03',source:'https://mp.weixin.qq.com/s/a?x=1&y=2',html:`<p style="text-align:center">正文 &amp; 文字</p><img src="data:image/png;base64,${PNG}" alt="图" referrerpolicy="no-referrer" loading="eager" />`},defaultSettings);
  const result=preparePdfHtml(html);
  assert.match(result,/@page\{size:A4/);assert.match(result,/文章 &amp; &lt;标题&gt;/);
  assert.match(result,/img-src data:/);assert.match(result,/script-src &#39;none&#39;/);
  assert.ok(result.indexOf('Content-Security-Policy')<result.indexOf('<meta charset='));
});

test('rejects executable HTML, external resources, CSS imports and malformed documents',()=>{
  const badBodies=['<script>alert(1)</script>','<iframe src="file:///etc/passwd"></iframe>','<object data="x"></object>','<embed src="x">','<svg onload="x"></svg>','<img src="https://example.com/a.png">','<img src="file:///etc/passwd">','<img src="data:image/svg+xml;base64,PHN2Zz4=">','<img src="data:image/png;base64,YQ==" onerror="x">','<img src="data:image/png;base64,YQ==" srcset="https://example.com/p.png 2x">','<a href="javascript:alert(1)">a</a>','<a href="&#106;avascript:alert(1)">a</a>','<p style="background:url(https://example.com)">x</p>','<form action="https://example.com"></form>'];
  for(const body of badBodies)assert.throws(()=>preparePdfHtml(doc(body)),PdfExportError,body);
  for(const extra of ['<base href="file:///">','<meta http-equiv="refresh" content="0;url=https://example.com">','<link rel="stylesheet" href="https://example.com">'])assert.throws(()=>preparePdfHtml(valid.replace('<head>','<head>'+extra)),PdfExportError);
  for(const css of ['@import "https://example.com";','body{background:u\\72l(https://example.com)}','body{background:u/**/rl(https://example.com)}','body{background:image-set("https://example.com")}', '@font-face{src:local(x)}'])assert.throws(()=>preparePdfHtml(valid.replace('@page{size:A4;margin:18mm}',css)),PdfExportError,css);
  assert.throws(()=>preparePdfHtml('<html></html>'),PdfExportError);
  assert.throws(()=>preparePdfHtml(valid.replace('</body>','')),PdfExportError);
  assert.throws(()=>preparePdfHtml('x'.repeat(MAX_PDF_HTML_BYTES+1)),e=>e.status===413);
});

test('finds Windows Edge before Chrome using explicit installed locations',async()=>{
  const checked=[];
  const result=await findInstalledBrowser({platform:'win32',env:{PROGRAMFILES:'C:\\Program Files','ProgramFiles(x86)':'C:\\Program Files (x86)',LOCALAPPDATA:'C:\\Users\\Test User\\AppData\\Local'},exists:async candidate=>{checked.push(candidate);return candidate==='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';}});
  assert.match(result,/Microsoft\\Edge\\Application\\msedge\.exe$/);assert.equal(checked.length,2);
  await assert.rejects(findInstalledBrowser({platform:'win32',env:{},exists:async()=>false}),e=>e.code==='PDF_BROWSER_MISSING'&&e.status===503);
});

test('renders with argument arrays, private profile, validated output and cleans temporary files',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wencang-pdf-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let count=0;
  const exporter=createPdfExporter({tempRoot:root,browserFinder:async()=>'/mock browser/edge',runner:async(executable,args,opts)=>{
    count++;assert.equal(executable,'/mock browser/edge');assert.equal(opts.timeoutMs,45000);
    assert.ok(args.includes('--headless'));assert.ok(args.includes('--no-pdf-header-footer'));
    assert.ok(args.some(a=>a.startsWith('--user-data-dir='+root)));assert.ok(!args.some(a=>/no-sandbox|disable-web-security|remote-debugging/.test(a)));
    const input=fileURLToPath(args.at(-1));assert.match(await readFile(input,'utf8'),/Content-Security-Policy/);
    const output=args.find(a=>a.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);await writeFile(output,PDF);
  }});
  assert.deepEqual(await exporter(valid),PDF);assert.equal(count,1);assert.deepEqual(await readdir(root),[]);
  const failing=createPdfExporter({tempRoot:root,browserFinder:async()=>'/mock',runner:async()=>{throw new PdfExportError('timed out','PDF_TIMEOUT',504);}});
  await assert.rejects(failing(valid),e=>e.code==='PDF_TIMEOUT');assert.deepEqual(await readdir(root),[]);
  const missing=createPdfExporter({tempRoot:root,browserFinder:async()=>'/mock',runner:async()=>{}});
  await assert.rejects(missing(valid),e=>e.code==='PDF_OUTPUT_MISSING');assert.deepEqual(await readdir(root),[]);
});

test('serializes conversions, bounds queue and resumes after each completion',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wencang-pdf-queue-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let running=0,peak=0,calls=0;const releases=[];
  const exporter=createPdfExporter({tempRoot:root,maxQueued:1,browserFinder:async()=>'/mock',runner:async(_,args)=>{
    running++;calls++;peak=Math.max(peak,running);await new Promise(resolve=>releases.push(resolve));
    await writeFile(args.find(a=>a.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length),PDF);running--;
  }});
  const first=exporter(valid),second=exporter(valid);
  await assert.rejects(exporter(valid),e=>e.code==='PDF_QUEUE_FULL'&&e.status===429);
  while(!releases.length)await new Promise(resolve=>setImmediate(resolve));releases.shift()();await first;
  while(!releases.length)await new Promise(resolve=>setImmediate(resolve));releases.shift()();await second;
  assert.equal(calls,2);assert.equal(peak,1);assert.deepEqual(await readdir(root),[]);
});

test('local PDF endpoint enforces request format and returns bytes or structured errors',async t=>{
  const server=createLocalServer({pdfExporter:async html=>{if(html==='bad')throw new PdfExportError('缺少浏览器','PDF_BROWSER_MISSING',503);return PDF;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  assert.equal((await fetch(base+'/api/pdf')).status,405);
  assert.equal((await fetch(base+'/api/pdf',{method:'POST',body:'x'})).status,415);
  const post=body=>fetch(base+'/api/pdf',{method:'POST',headers:{'content-type':'application/json'},body});
  assert.equal((await post('not json')).status,400);assert.equal((await post('{}')).status,400);
  const response=await post(JSON.stringify({html:valid}));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await response.arrayBuffer()),PDF);
  const failure=await post(JSON.stringify({html:'bad'}));assert.equal(failure.status,503);assert.equal((await failure.json()).code,'PDF_BROWSER_MISSING');
  assert.equal((await fetch(base+'/api/pdf',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({html:valid})})).status,403);
  assert.equal((await (await fetch(base+'/api/health')).json()).version,'1.3');
});
