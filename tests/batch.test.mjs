import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBatchJson,MAX_BATCH_ENTRIES,MAX_BATCH_JSON_BYTES} from '../source/src/batch.ts';
import {printCollectionDocument,printDocument,defaultSettings} from '../source/src/article.ts';
const url = (mid = '1', scene = '1') => `http://mp.weixin.qq.com/s?__biz=test%3D%3D&mid=${mid}&idx=1&sn=signature&scene=${scene}#rd`;
const row = (mid = '1') => ({title:`测试文章 ${mid}`,url:url(mid),publishedAt:'2026-11-03T00:30:00+08:00',digest:'只有摘要，不能当成正文',coverUrl:'https://mmbiz.qpic.cn/image'});
const article = title => ({title,author:'作者 <A>',date:'2026-11-03',source:url(),html:'<p>完整正文</p>'});

test('actual export schema imports metadata and leaves all articles pending', () => {
 const parsed=parseBatchJson(JSON.stringify({account:{name:'测试公众号'},articles:[row(),row('2')],count:2}));
 assert.equal(parsed.accountName,'测试公众号'); assert.equal(parsed.entries.length,2);
 assert.equal(parsed.entries[0].title,'测试文章 1'); assert.equal(parsed.entries[0].date,'2026-11-03');
 assert.equal(parsed.entries[0].author,'测试公众号');
 for(const entry of parsed.entries){assert.equal(entry.status,'pending');assert.equal(entry.article,undefined);assert.equal(entry.selected,true);assert.ok(entry.url.startsWith('https://'));assert.ok(!entry.url.includes('#'));}
});
test('deduplicates tracking variants, preserves first order and reports invalid rows',()=>{
 const parsed=parseBatchJson(JSON.stringify({articles:[row('1'),{...row('1'),url:url('1','20')},{title:'私网',url:'http://127.0.0.1/s/x'},row('2'),null,{}],count:100}));
 assert.equal(parsed.entries.length,5);assert.deepEqual(parsed.entries.filter(e=>e.status==='pending').map(e=>e.title),['测试文章 1','测试文章 2']);
 assert.equal(parsed.entries.filter(e=>e.status==='error').length,3);
 for(const entry of parsed.entries.filter(e=>e.status==='error')){assert.equal(entry.selected,false);assert.ok(entry.error);assert.equal(entry.url,'');}
 assert.ok(parsed.warnings.some(s=>s.includes('1 条重复')));assert.ok(parsed.warnings.some(s=>s.includes('实际读取到 6')));
});
test('rejects malformed input and size limits without truncation',()=>{
 assert.throws(()=>parseBatchJson('not-json'),/JSON 格式/);
 for(const value of [{},null,1,{articles:[]},{articles:'invalid'}])assert.throws(()=>parseBatchJson(JSON.stringify(value)));
 assert.throws(()=>parseBatchJson(JSON.stringify(Array.from({length:MAX_BATCH_ENTRIES+1},()=>row()))),/最多导入/);
 assert.throws(()=>parseBatchJson(' '.repeat(MAX_BATCH_JSON_BYTES+1)),/超过 2 MB/);
 assert.throws(()=>parseBatchJson('中'.repeat(Math.ceil(MAX_BATCH_JSON_BYTES/3))),/超过 2 MB/);
});
test('strict remote URL boundaries, BOM and Shanghai date fallback',()=>{
 const bad=['javascript:alert(1)','https://mp.weixin.qq.com.evil.test/s/a','https://user:pass@mp.weixin.qq.com/s/a','https://mp.weixin.qq.com:444/s/a','https://mp.weixin.qq.com/login','https://mp.weixin.qq.com/s?mid=1'];
 const parsed=parseBatchJson('\uFEFF'+JSON.stringify([...bad.map(url=>({url})),{title:'short',url:'https://mp.weixin.qq.com/s/test_abc-123',publishedAt:'bad',publishedAtUnix:Date.parse('2026-11-02T17:00:00Z')/1000}]));
 assert.equal(parsed.entries.filter(e=>e.status==='error').length,bad.length);
 assert.equal(parsed.entries.at(-1).date,'2026-11-03');assert.equal(parsed.entries.at(-1).status,'pending');
});
test('collection prints a contents page, escaped text, and page breaks in original order',()=>{
 const articles=[article('<script>alert(1)</script>'),article('第二篇 & 文章')];
 const printed=printCollectionDocument(articles,defaultSettings);
 assert.ok(printed.includes('文章合集（2 篇）'));assert.ok(printed.includes('collection-contents'));
 assert.ok(printed.includes('href="#collection-article-1"'));assert.ok(printed.includes('id="collection-article-2"'));
 assert.ok(printed.includes('page-break-before:always'));assert.ok(printed.includes('page-break-after:always'));
 assert.ok(printed.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!printed.includes('<script>'));
 assert.ok(printed.includes('作者 &lt;A&gt;'));assert.ok(printed.includes('第二篇 &amp; 文章'));
 assert.equal((printed.match(/<p>完整正文<\/p>/g)||[]).length,2);
 const minimal=printCollectionDocument(articles,{...defaultSettings,metadata:false,source:false,images:false,paper:'A5'});
 assert.ok(!minimal.includes('作者 &lt;A&gt;'));assert.ok(!minimal.includes('原文链接：'));assert.ok(minimal.includes('@page{size:A5;'));
 assert.equal(printCollectionDocument([articles[0]],defaultSettings),printDocument(articles[0],defaultSettings));
 assert.throws(()=>printCollectionDocument([],defaultSettings),/至少一篇/);
});

