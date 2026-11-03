import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {pdfFilename,pdfFilenames,createPdfZip,inlineImageSource} from '../source/src/pdf-files.ts';

test('PDF filenames normalize publication dates and unsafe Windows characters',()=>{
  assert.equal(pdfFilename({title:'宝山站：封顶/新进展？',date:'2026年11月3日'}),'2026-11-03_宝山站：封顶_新进展？.pdf');
  assert.equal(pdfFilename({title:'标题',date:'2026-11-03T10:13:36+08:00'}),'2026-11-03_标题.pdf');
  assert.equal(pdfFilename({title:'a<>:"/\\|?*\u0000 . ',date:'2024/2/29'}),'2024-02-29_a__________.pdf');
  assert.equal(pdfFilename({title:'标题',date:'2026-02-29'}),'日期不详_标题.pdf');
  assert.equal(pdfFilename({title:'标题',date:''}),'日期不详_标题.pdf');
  assert.equal(pdfFilename({title:'',date:''},3),'日期不详_未命名文章4.pdf');
  assert.ok(!pdfFilename({title:'😀'.repeat(150),date:'2026-11-03'}).includes('\ufffd'));
});

test('PDF filenames deduplicate case-insensitively without collisions with suffix titles',()=>{
  const articles=['Article','article','Article(2)','Article'].map(title=>({title,date:'2026-11-03'}));
  assert.deepEqual(pdfFilenames(articles),['2026-11-03_Article.pdf','2026-11-03_article(2).pdf','2026-11-03_Article(2)(2).pdf','2026-11-03_Article(3).pdf']);
});

test('ZIP is independently readable by Python zipfile, with Unicode, bytes and CRC intact',async(t)=>{
  const python=['python3','python'].find(cmd=>spawnSync(cmd,['-c','import zipfile'],{stdio:'ignore'}).status===0);
  if(!python){t.skip('Optional Python ZIP compatibility check: Python unavailable');return;}
  const files=[{name:'2026-11-03_宝山站封顶.pdf',bytes:new TextEncoder().encode('%PDF-1.4\n中文正文')},{name:'日期不详_第二篇(2).pdf',bytes:new Uint8Array([0,255,128,15,10])}];
  const zip=createPdfZip(files);assert.deepEqual(zip,createPdfZip(files));
  const dir=await mkdtemp(path.join(tmpdir(),'wencang-zip-'));
  try{
    const filename=path.join(dir,'batch.zip');await writeFile(filename,zip);
    const output=execFileSync(python,['-c',`import zipfile,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps([{'name':i.filename,'bytes':list(z.read(i.filename)),'utf8':bool(i.flag_bits&2048),'method':i.compress_type} for i in z.infolist()],ensure_ascii=False))`,filename],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(output),files.map(f=>({name:f.name,bytes:[...f.bytes],utf8:true,method:0})));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ZIP rejects path traversal and duplicate names',()=>{
  const bytes=new Uint8Array();
  assert.throws(()=>createPdfZip([{name:'../x.pdf',bytes}]),/目录/);
  assert.throws(()=>createPdfZip([{name:'x.pdf',bytes},{name:'X.pdf',bytes}]),/重复/);
  assert.equal(createPdfZip([]).byteLength,22);
});

test('inline image conversion permits data raster or generated blobs only',async()=>{
  const data='data:image/png;base64,aGVsbG8=';let called=0;
  assert.equal(await inlineImageSource(data,{convertBlob:async()=>{called++;return data;}}),data);
  assert.equal(called,0);
  assert.equal(await inlineImageSource('blob:http://127.0.0.1/a',{convertBlob:async url=>{assert.match(url,/^blob:/);called++;return data;}}),data);
  assert.equal(called,1);
  for(const url of ['https://mmbiz.qpic.cn/a','/api/image?url=x','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4='])await assert.rejects(inlineImageSource(url,{convertBlob:async()=>{throw Error('must not run');}}),/未缓存/);
  await assert.rejects(inlineImageSource('blob:x',{convertBlob:async()=>'<svg/>'}),/格式/);
});
