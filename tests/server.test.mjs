import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, symlink, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createLocalServer,validRemote,fetchRemote,createImageLoader} from '../server.mjs';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test('remote URLs are limited to article or image hosts and HTTPS', async () => {
  assert.equal(validRemote('http://mp.weixin.qq.com/s/example#abc','article').href,'https://mp.weixin.qq.com/s/example');
  for (const raw of ['https://example.com/s/a','https://127.0.0.1/s/a','https://mp.weixin.qq.com.evil.test/s/a','https://a:b@mp.weixin.qq.com/s/a','https://mp.weixin.qq.com:444/s/a','https://mp.weixin.qq.com/login','file:///etc/passwd','https://mmbiz.qpic.cn/a']) assert.throws(()=>validRemote(raw,'article'));
  assert.equal(validRemote('https://mmbiz.qpic.cn/a/0','image').hostname,'mmbiz.qpic.cn');
  assert.throws(()=>validRemote('https://example.com/p.png','image'));
});

test('remote fetch rejects off-host redirects, non-image content and oversized bodies', async () => {
  let count=0;
  await assert.rejects(fetchRemote('https://mp.weixin.qq.com/s/a','article', async ()=>{count++;return new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}})}));
  assert.equal(count,1);
  await assert.rejects(fetchRemote('https://mmbiz.qpic.cn/a','image',async()=>new Response('<html>x</html>',{headers:{'content-type':'text/html'}})),/图片/);
  await assert.rejects(fetchRemote('https://mp.weixin.qq.com/s/a','article',async()=>new Response('small',{headers:{'content-length':'6000001'}})),/过大/);
  await assert.rejects(fetchRemote('https://mp.weixin.qq.com/s/a','article',async()=>new Response(new Uint8Array(6_000_001))),/过大/);
  count=0;
  await assert.rejects(fetchRemote('https://mp.weixin.qq.com/s/a','article',async()=>{count++;return new Response('',{status:302,headers:{location:'/s/a'}})}),/跳转次数/);
  assert.equal(count,4);
});

test('local server serves UI and APIs, fails safely, enforces localhost scope', async t => {
  const tmp=await mkdtemp(path.join(os.tmpdir(),'wencang-test-'));
  await writeFile(path.join(tmp,'index.html'),'<!doctype html><title>Fixture</title>文藏测试');
  await writeFile(path.join(tmp,'server.mjs'),'SECRET');
  await mkdir(path.join(tmp,'assets'));
  await writeFile(path.join(tmp,'assets','app.js'),'window.fixture=true;');
  const outsideDir=await mkdtemp(path.join(os.tmpdir(),'wencang-outside-'));
  t.after(()=>rm(outsideDir,{recursive:true,force:true}));
  const outside=path.join(outsideDir,'outside.txt');await writeFile(outside,'outside fixture');
  try{await symlink(outside,path.join(tmp,'assets','outside.js'));}catch(e){if(process.platform!=='win32'||!['EPERM','EACCES'].includes(e.code))throw e;}
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.redirect,'manual'); assert.ok(opts.signal instanceof AbortSignal);
    if(url.hostname==='mmbiz.qpic.cn')return new Response(TINY_PNG,{headers:{'content-type':'image/png'}});
    if(url.pathname==='/s/blocked')return new Response('<html>verification required</html>');
    if(url.pathname==='/s/network')throw new TypeError('fetch failed');
    return new Response('<html><div id="js_content"><p>正文</p></div></html>',{headers:{'content-type':'text/html'}});
  };
  const server=createLocalServer({root:tmp,fetchImpl});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(), base=`http://127.0.0.1:${address.port}`;
  assert.equal(address.address,'127.0.0.1');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true});});
  assert.equal((await fetch(base+'/')).status,200);
  assert.match(await (await fetch(base+'/')).text(),/文藏测试/);
  assert.equal((await fetch(base+'/index.html',{method:'HEAD'})).status,200);
  assert.equal(await (await fetch(base+'/index.html',{method:'HEAD'})).text(),'');
  assert.equal((await fetch(base+'/assets/app.js')).status,200);
  for(const suffix of ['/server.mjs','/README.txt','/.env','/assets/outside.js','/assets/%2e%2e%2fserver.mjs','/assets/%zz'])assert.equal((await fetch(base+suffix)).status,suffix.endsWith('%zz')?400:404,suffix);
  assert.equal((await fetch(base+'/api/health')).status,200);
  assert.equal((await fetch(base+'/api/health',{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:{origin:base}})).status,200);
  const foreignHost=await new Promise((resolve,reject)=>{const r=http.get(base+'/api/health',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject)});
  assert.equal(foreignHost,403);
  assert.equal((await fetch(base+'/api/article')).status,405);
  assert.equal((await fetch(base+'/api/article',{method:'POST',body:'x'})).status,415);
  const post=body=>fetch(base+'/api/article',{method:'POST',headers:{'content-type':'application/json'},body});
  assert.equal((await post('bad')).status,400);
  assert.equal((await post('null')).status,400);
  assert.equal((await post(JSON.stringify({url:'https://example.com/a'}))).status,400);
  assert.equal((await post('a'.repeat(13000))).status,400);
  const normal=await post(JSON.stringify({url:'https://mp.weixin.qq.com/s/normal'}));
  assert.equal(normal.status,200); assert.match((await normal.json()).html,/正文/);
  assert.equal((await post(JSON.stringify({url:'https://mp.weixin.qq.com/s/blocked'}))).status,422);
  assert.equal((await post(JSON.stringify({url:'https://mp.weixin.qq.com/s/network'}))).status,502);
  const image=await fetch(base+'/api/image?url='+encodeURIComponent('https://mmbiz.qpic.cn/a'));
  assert.equal(image.status,200); assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),TINY_PNG);
  assert.equal((await fetch(base+'/api/image?url='+encodeURIComponent('https://evil.test/a'))).status,400);
  const duplicate=createLocalServer({root:tmp}); duplicate.listen(address.port,'127.0.0.1'); const [err]=await once(duplicate,'error'); assert.equal(err.code,'EADDRINUSE');
});


test('image requests share work, cache successful bytes, and limit active downloads', async () => {
  let active = 0, highest = 0, calls = 0;
  const releases = [];
  const loader = createImageLoader(async () => {
    calls++; active++; highest = Math.max(highest, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    return new Response(TINY_PNG, {headers:{'content-type':'image/png'}});
  });
  const urls = Array.from({length: 9}, (_,i) => `https://mmbiz.qpic.cn/${i}`);
  const pending = [...urls.map(url => loader(url)), loader(urls[0])];
  assert.equal(calls, 4);
  while (calls < 9 || active) {
    for (const release of releases.splice(0)) release();
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = await Promise.all(pending);
  assert.equal(highest,4); assert.equal(calls,9);
  assert.deepEqual(result[0].bytes,TINY_PNG);
  assert.equal(result[0],result[9]);
  assert.equal(await loader(urls[0]),result[0]); assert.equal(calls,9);
});

test('image memory cache evicts old entries, expires, and never caches failures', async () => {
  let calls=0, clock=1;
  const loader=createImageLoader(async () => {calls++;return new Response(TINY_PNG,{headers:{'content-type':'image/png'}});}, {maxBytes:TINY_PNG.length*2,now:()=>clock});
  const url=s=>`https://mmbiz.qpic.cn/${s}`;
  await loader(url('a'));await loader(url('b'));await loader(url('c'));
  await loader(url('b'));assert.equal(calls,3);
  await loader(url('a'));assert.equal(calls,4);
  clock+=3_600_000;await loader(url('a'));assert.equal(calls,5);
  let attempts=0;
  const retriable=createImageLoader(async()=>{attempts++;if(attempts===1)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});return new Response(TINY_PNG,{headers:{'content-type':'image/png'}});});
  await assert.rejects(retriable(url('retry')),e=>e.code==='IMAGE_DNS');
  assert.deepEqual((await retriable(url('retry'))).bytes,TINY_PNG);assert.equal(attempts,2);
});

test('image API reports HTTP status, format, timeout and network errors without returning URLs', async t => {
  const server=createLocalServer({fetchImpl: async url => {
    if(url.pathname==='/http')return new Response('blocked',{status:403});
    if(url.pathname==='/type')return new Response('page',{headers:{'content-type':'text/html'}});
    if(url.pathname==='/timeout')throw new DOMException('timed out','TimeoutError');
    if(url.pathname==='/dns')throw Object.assign(new TypeError('secret URL'),{cause:{code:'ENOTFOUND'}});
    if(url.pathname==='/tls')throw Object.assign(new TypeError('secret URL'),{cause:{code:'CERT_HAS_EXPIRED'}});
    if(url.pathname==='/redirect')return new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}});
    return new Response(TINY_PNG,{headers:{'content-type':'image/png'}});
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  for(const [name,code,status] of [['http','IMAGE_HTTP',502],['type','IMAGE_TYPE',502],['timeout','IMAGE_TIMEOUT',504],['dns','IMAGE_DNS',502],['tls','IMAGE_TLS',502],['redirect','IMAGE_REDIRECT',502]]){
    const response=await fetch(base+'/api/image?url='+encodeURIComponent('https://mmbiz.qpic.cn/'+name));
    assert.equal(response.status,status);assert.match(response.headers.get('content-type'),/application\/json/);
    const data=await response.json();assert.equal(data.code,code);assert.ok(data.error);assert.doesNotMatch(data.error,/secret|https?:/);
    if(name==='http'){assert.equal(data.upstreamStatus,403);assert.match(data.error,/403/);}
  }
});
