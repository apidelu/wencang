import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImageSources } from '../source/src/print-images.ts';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('67 images are queued at max four concurrent loads; duplicates reuse success',async()=>{
  let active=0, peak=0, calls=0, releases=0;
  const progress=[];
  const urls=Array.from({length:67},(_,i)=>`/api/image?url=${i}`);
  const result=await prepareImageSources([...urls,urls[0]],{timeoutMs:100,onProgress:(...v)=>progress.push(v),loadImageSource:async url=>{
    active++;peak=Math.max(peak,active);calls++;await wait(3);active--;
    return {src:'blob:'+url,release:()=>releases++};
  }});
  assert.equal(calls,67);assert.equal(peak,4);assert.equal(result.sources.size,67);assert.deepEqual(result.failures,[]);
  assert.deepEqual(progress[0],[0,67]);assert.deepEqual(progress.at(-1),[67,67]);
  result.release();result.release();assert.equal(releases,67);
});

test('per-start timeouts allow queued images to complete and failures count references',async()=>{
  const calls=[];
  const result=await prepareImageSources(['one','slow','bad','four','five','bad'],{concurrency:1,timeoutMs:20,loadImageSource:async url=>{
    calls.push(url);
    if(url==='slow') return new Promise(()=>{});
    await wait(7);
    if(url==='bad')throw new Error('网络无法访问');
    return {src:'blob:'+url};
  }});
  assert.deepEqual(calls,['one','slow','bad','four','five']);
  assert.deepEqual([...result.sources.keys()],['one','four','five']);
  assert.deepEqual(result.failures,[{url:'slow',reason:'图片读取超时。',count:1},{url:'bad',reason:'网络无法访问',count:2}]);
});

test('late cancelled loads are cleaned up and cancellation stops new jobs',async()=>{
  const abort=new AbortController();let calls=0,releases=0;
  const task=prepareImageSources(['ready','late','never'],{concurrency:1,signal:abort.signal,loadImageSource:async url=>{
    calls++;if(url==='late'){await wait(20);}return {src:'blob:'+url,release:()=>releases++};
  },onProgress:done=>{if(done===1)setTimeout(()=>abort.abort(),2);}});
  await assert.rejects(task,{name:'AbortError'});await wait(25);
  assert.equal(calls,2);assert.equal(releases,2);
});

test('an already cancelled operation does no fetching',async()=>{
  const abort=new AbortController();abort.abort();let calls=0;
  await assert.rejects(prepareImageSources(['x'],{signal:abort.signal,loadImageSource:async()=>{calls++;return {src:'x'};}}),{name:'AbortError'});
  assert.equal(calls,0);
});
