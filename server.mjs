// 文藏本地服务：Node.js 22+，仅使用内置模块，不需要 npm install。
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {createPdfExporter, PdfExportError, MAX_PDF_HTML_BYTES} from './pdf-export.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);

export function validRemote(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的网址。'); }
  const hosts = kind === 'article' ? ['mp.weixin.qq.com'] : ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'];
  if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error(kind === 'article' ? '请使用 mp.weixin.qq.com 开头的微信公众号文章链接。' : '不支持此图片地址。');
  }
  if (kind === 'article' && url.pathname !== '/s' && !/^\/s\/[a-zA-Z0-9_-]+$/.test(url.pathname)) throw new Error('请粘贴具体的公众号文章链接。');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

export class ImageReadError extends Error {
  constructor(message, code, upstreamStatus) {
    super(message); this.name = 'ImageReadError'; this.code = code;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

function imageFetchError(error) {
  if (error instanceof ImageReadError) return error;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return new ImageReadError('图片读取超时，请检查网络后重试。', 'IMAGE_TIMEOUT');
  const cause = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause)) return new ImageReadError('无法解析图片服务器地址，请检查本机网络或 DNS。', 'IMAGE_DNS');
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(cause)) return new ImageReadError('图片服务器的安全连接验证失败，请检查系统时间或网络设置。', 'IMAGE_TLS');
  return new ImageReadError('无法连接图片服务器，请检查本机网络后重试。', 'IMAGE_NETWORK');
}

export async function fetchRemote(value, kind, fetchImpl = globalThis.fetch) {
  let url = validRemote(value, kind);
  const signal = AbortSignal.timeout(18000);
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual', signal,
        headers: {'User-Agent': 'Mozilla/5.0 (compatible; WenCang/1.0)', Accept: kind === 'article' ? 'text/html' : 'image/avif,image/webp,image/*'},
      });
    } catch (error) { throw kind === 'image' ? imageFetchError(error) : error; }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw kind === 'image' ? new ImageReadError('图片服务器跳转地址缺失。', 'IMAGE_REDIRECT') : new Error('原文跳转失败，请使用粘贴正文导入。');
      try {url = validRemote(new URL(location, url).href, kind);} catch (error) {throw kind === 'image' ? new ImageReadError('图片跳转到了不支持的地址，已停止读取。', 'IMAGE_REDIRECT') : error;}
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (kind === 'image') throw new ImageReadError(`图片服务器返回 HTTP ${res.status}，暂时无法读取。`, 'IMAGE_HTTP', res.status);
      throw new Error('微信暂时无法读取此内容，请打开原文后粘贴正文导入。');
    }
    const type = res.headers.get('content-type') || '';
    if (kind === 'image' && !/^image\/(png|jpeg|jpg|webp|gif|avif)(;|$)/i.test(type)) {
      await res.body?.cancel(); throw new ImageReadError('图片服务器返回的内容不是支持的图片格式。', 'IMAGE_TYPE');
    }
    const max = kind === 'article' ? 6_000_000 : 10_000_000;
    if (Number(res.headers.get('content-length')) > max) { await res.body?.cancel(); throw kind === 'image' ? new ImageReadError('图片超过 10 MB，无法读取。', 'IMAGE_SIZE') : new Error('内容过大，请改用粘贴正文导入。'); }
    const reader = res.body?.getReader();
    if (!reader) throw kind === 'image' ? new ImageReadError('图片服务器返回空内容。', 'IMAGE_EMPTY') : new Error('返回内容为空。');
    const chunks = []; let size = 0;
    while (true) {
      const {done, value: chunk} = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > max) { await reader.cancel(); throw kind === 'image' ? new ImageReadError('图片超过 10 MB，无法读取。', 'IMAGE_SIZE') : new Error('内容过大，请改用粘贴正文导入。'); }
      chunks.push(chunk);
    }
    return {bytes: Buffer.concat(chunks, size), type, url: url.href};
  }
  throw kind === 'image' ? new ImageReadError('图片服务器跳转次数过多。', 'IMAGE_REDIRECT') : new Error('原文跳转次数过多，请改用粘贴正文导入。');
}

/** Cache only successful image bytes, share concurrent requests, and start timeouts after a slot is available. */
export function createImageLoader(fetchImpl = globalThis.fetch, {maxBytes = 64_000_000, maxEntries = 256, concurrency = 4, now = Date.now} = {}) {
  const cache = new Map(), inFlight = new Map(), queue = [];
  let bytes = 0, active = 0;
  const remove = key => {const old = cache.get(key); if (old) {bytes -= old.result.bytes.length; cache.delete(key);}};
  const drain = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift(); active++;
      job.run().then(job.resolve, job.reject).finally(() => {active--; drain();});
    }
  };
  const schedule = run => new Promise((resolve, reject) => {queue.push({run, resolve, reject}); drain();});
  return async function loadImage(value) {
    const key = validRemote(value, 'image').href;
    const hit = cache.get(key);
    if (hit && now() - hit.savedAt < 3_600_000) {
      cache.delete(key); cache.set(key, hit); return hit.result;
    }
    if (hit) remove(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const task = schedule(async () => {
      let result;
      try {result = await fetchRemote(key, 'image', fetchImpl);} catch (error) {throw imageFetchError(error);}
      if (result.bytes.length <= maxBytes) {
        while (cache.size && (bytes + result.bytes.length > maxBytes || cache.size >= maxEntries)) remove(cache.keys().next().value);
        cache.set(key, {result, savedAt: now()}); bytes += result.bytes.length;
      }
      return result;
    });
    inFlight.set(key, task);
    try {return await task;} finally {inFlight.delete(key);}
  };
}

function send(res, status, data, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin', ...headers,
  });
  res.end(typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
}

function readBody(req, max = 12000, tooLarge = '链接过长，请重新复制。') {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, ended = false;
    const fail = message => { if (ended) return; ended = true; reject(new Error(message)); };
    req.on('data', chunk => {
      if (ended) return;
      size += chunk.length;
      if (size > max) { chunks.length = 0; fail(tooLarge); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => fail('请求中断，请重试。'));
    req.on('aborted', () => fail('请求中断，请重试。'));
  });
}

export function createLocalServer({root = APP_ROOT, fetchImpl = globalThis.fetch, pdfExporter = createPdfExporter()} = {}) {
  const loadImage = createImageLoader(fetchImpl);
  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (!hosts.includes(host) || (origin && !hosts.some(h => origin === `http://${h}`)) || req.headers['sec-fetch-site'] === 'cross-site') {
        return send(res, 403, {error: '此服务只接受本机页面的请求。请使用启动窗口显示的网址。'});
      }
      let url;
      try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, {error: '请求地址无效。'}); }
      if (url.host !== host || url.protocol !== 'http:') return send(res, 400, {error: '请求地址无效。'});
      if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, {ok: true, app: 'wencang-local', version: '1.3'});
      if (url.pathname === '/api/article') {
        if (req.method !== 'POST') return send(res, 405, {error: '请使用页面上的「读取文章」。'}, undefined, {Allow: 'POST'});
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, {error: '请求格式不正确，请刷新页面后重试。'});
        let data;
        try { const body = await readBody(req); data = JSON.parse(body); } catch (e) { return send(res, 400, {error: e.message === '链接过长，请重新复制。' ? e.message : '请求格式不正确，请重新粘贴链接。'}); }
        if (!data || typeof data.url !== 'string' || data.url.length > 8000) return send(res, 400, {error: '请输入有效的文章链接。'});
        try { validRemote(data.url, 'article'); } catch (e) { return send(res, 400, {error: e.message}); }
        try {
          const result = await fetchRemote(data.url, 'article', fetchImpl);
          const html = result.bytes.toString('utf8');
          if (!/id\s*=\s*["']js_content["']/i.test(html)) return send(res, 422, {error: '微信暂未返回文章正文，可能需要验证或文章已不可访问。请在微信中复制正文，切换到「粘贴正文」导入。'});
          return send(res, 200, {html, source: result.url});
        } catch (e) {
          return send(res, 502, {error: e.name === 'TimeoutError' || e.name === 'AbortError' ? '读取超时。请检查网络后重试，或使用粘贴正文导入。' : '暂时无法读取链接。请检查本机网络；也可以打开原文复制内容，使用粘贴正文导入。'});
        }
      }
      if (url.pathname === '/api/pdf') {
        if (req.method !== 'POST') return send(res, 405, {error: '请使用页面上的 PDF 导出按钮。'}, undefined, {Allow: 'POST'});
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, {error: 'PDF 请求格式不正确，请刷新页面后重试。', code:'PDF_INVALID_REQUEST'});
        const tooLarge='单篇文档超过 64 MB，请减少图片后重试。';
        if (Number(req.headers['content-length']) > MAX_PDF_HTML_BYTES) return send(res, 413, {error: tooLarge, code:'PDF_TOO_LARGE'});
        let data;
        try {data=JSON.parse(await readBody(req,MAX_PDF_HTML_BYTES,tooLarge));} catch(error) {return send(res,error.message===tooLarge?413:400,{error:error.message===tooLarge?tooLarge:'PDF 请求格式不正确，请重新导出。',code:error.message===tooLarge?'PDF_TOO_LARGE':'PDF_INVALID_REQUEST'});}
        if (!data || typeof data.html !== 'string') return send(res,400,{error:'没有收到需要导出的文档。',code:'PDF_INVALID_REQUEST'});
        try {
          const bytes=await pdfExporter(data.html);
          return send(res,200,bytes,'application/pdf',{'Content-Disposition':'attachment; filename="article.pdf"'});
        } catch(error) {
          return send(res,error instanceof PdfExportError?error.status:500,{error:error instanceof PdfExportError?error.message:'本地 PDF 转换失败，请重新启动文藏后重试。',code:error instanceof PdfExportError?error.code:'PDF_FAILED'});
        }
      }
      if (url.pathname === '/api/image') {
        if (req.method !== 'GET') return send(res, 405, {error: '请求方式不支持。'}, undefined, {Allow: 'GET'});
        const imageUrl = url.searchParams.get('url') || '';
        if (imageUrl.length > 8000) return send(res, 400, {error: '图片地址过长。'});
        try { validRemote(imageUrl, 'image'); } catch (e) { return send(res, 400, {error: e.message}); }
        try {
          const result = await loadImage(imageUrl);
          return send(res, 200, result.bytes, result.type, {'Cache-Control': 'private, max-age=3600'});
        } catch (error) {
          const detail = imageFetchError(error);
          return send(res, detail.code === 'IMAGE_TIMEOUT' ? 504 : 502, {error: detail.message, code: detail.code, ...(detail.upstreamStatus ? {upstreamStatus: detail.upstreamStatus} : {})});
        }
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, {error: '请求方式不支持。'}, undefined, {Allow: 'GET, HEAD'});
      let relative;
      try { relative = decodeURIComponent(url.pathname); } catch { return send(res, 400, {error: '请求地址无效。'}); }
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) return send(res, 404, {error: '文件不存在。'});
      if (relative === '/' || relative === '/index.html') relative = '/index.html';
      else if (!/^\/assets\/[a-zA-Z0-9_./-]+$/.test(relative)) return send(res, 404, {error: '文件不存在。'});
      const type = MIME.get(path.extname(relative).toLowerCase());
      if (!type) return send(res, 404, {error: '文件不存在。'});
      try {
        const rootReal = await realpath(root);
        const filename = await realpath(path.join(rootReal, relative));
        if (!filename.startsWith(rootReal + path.sep)) return send(res, 404, {error: '文件不存在。'});
        if (!(await stat(filename)).isFile()) return send(res, 404, {error: '文件不存在。'});
        const body = req.method === 'HEAD' ? '' : await readFile(filename);
        return send(res, 200, body, type);
      } catch { return send(res, 404, {error: '页面文件不存在。请先完整解压文件夹，再双击 Start.cmd。'}); }
    } catch { if (!res.headersSent) send(res, 500, {error: '本地服务遇到问题，请关闭启动窗口后重新运行 Start.cmd。'}); else res.destroy(); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

function openBrowser(url) {
  let child;
  // URL is a fixed localhost address, never article content or user input.
  if (process.platform === 'win32') child = spawn('cmd.exe', ['/d', '/c', 'start', '', url], {windowsHide: true, stdio: 'ignore'});
  else if (process.platform === 'darwin') child = spawn('open', [url], {stdio: 'ignore'});
  else child = spawn('xdg-open', [url], {stdio: 'ignore'});
  child.on('error', () => console.log('未能自动打开浏览器，请手动打开上面的网址。'));
  child.unref();
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('请先安装 Node.js 22 或更新版本：https://nodejs.org/'); process.exitCode = 1; return;
  }
  try { await stat(path.join(APP_ROOT, 'index.html')); } catch {
    console.error('没有找到 index.html。请完整解压压缩包，然后运行 Start.cmd。'); process.exitCode = 1; return;
  }
  const server = createLocalServer();
  server.on('error', err => {
    console.error(err.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用。请关闭之前打开的文藏启动窗口，再重试。` : `无法启动本地服务（${err.code || '未知错误'}）。请检查系统权限。`);
    process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`\n文藏本地版已启动\n\n打开：${url}\n\n此窗口需保持打开；按 Ctrl+C 或关闭窗口即可停止服务。\n公众号提取仍需联网，程序不会连接 ChatGPT。\n`);
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });
  process.on('SIGINT', () => { server.close(); server.closeAllConnections(); });
  process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
