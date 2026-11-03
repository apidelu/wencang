import type { Article } from "./article";

function publicationDate(value: string): string {
  const match = value.trim().match(/^(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?:日)?(?:$|[T\s])/);
  if (!match) return "日期不详";
  const year=Number(match[1]), month=Number(match[2]), day=Number(match[3]);
  const date=new Date(0); date.setUTCFullYear(year,month-1,day); date.setUTCHours(0,0,0,0);
  if (year<1 || month<1 || month>12 || day<1 || date.getUTCFullYear()!==year || date.getUTCMonth()!==month-1 || date.getUTCDate()!==day) return "日期不详";
  return `${match[1]}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function safeTitle(value: string, index: number): string {
  const clean=value.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,"_").replace(/\s+/g," ").replace(/[. ]+$/g,"").trim();
  return Array.from(clean || `未命名文章${index+1}`).slice(0,100).join("").replace(/[. ]+$/g,"");
}
export function pdfFilename(article: Pick<Article,"title"|"date">, index=0): string {
  return `${publicationDate(article.date || "")}_${safeTitle(article.title || "",index)}.pdf`;
}
/** Windows filenames compare without case; preserve order and never overwrite a duplicate. */
export function pdfFilenames(articles: Array<Pick<Article,"title"|"date">>): string[] {
  const used=new Set<string>();
  return articles.map((article,index)=>{
    const base=pdfFilename(article,index); let name=base, suffix=1;
    while(used.has(name.normalize("NFC").toLowerCase())) name=`${base.slice(0,-4)}(${++suffix}).pdf`;
    used.add(name.normalize("NFC").toLowerCase()); return name;
  });
}

const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{
  let crc=n;
  for(let bit=0;bit<8;bit++) crc=(crc&1) ? 0xedb88320^(crc>>>1) : crc>>>1;
  return crc>>>0;
});
function crc32(bytes: Uint8Array): number {
  let crc=0xffffffff;
  for(const byte of bytes) crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
export type PdfZipFile={name:string;bytes:Uint8Array};
/** Build a standard ZIP32 archive. Files are stored unchanged; UTF-8 names are explicit. */
export function createPdfZip(files: PdfZipFile[]): Uint8Array<ArrayBuffer> {
  if(files.length>65535) throw new Error("文件过多，请分批导出。");
  const encoder=new TextEncoder(), names=new Set<string>();
  const records=files.map(file=>{
    if(!file.name || /[\\/\u0000]/.test(file.name) || file.name==="." || file.name==="..") throw new Error("ZIP 文件名不能包含目录路径。");
    const key=file.name.normalize("NFC").toLowerCase();
    if(names.has(key)) throw new Error("ZIP 内存在重复文件名，请先为文章分别命名。");
    names.add(key);
    const name=encoder.encode(file.name);
    if(name.length>65535 || file.bytes.byteLength>0xffffffff) throw new Error("文件超过 ZIP32 大小限制，请分批导出。");
    return {...file,nameBytes:name,crc:crc32(file.bytes),offset:0};
  });
  const localSize=records.reduce((sum,file)=>sum+30+file.nameBytes.length+file.bytes.byteLength,0);
  const centralSize=records.reduce((sum,file)=>sum+46+file.nameBytes.length,0);
  const size=localSize+centralSize+22;
  if(size>0xffffffff) throw new Error("ZIP 文件过大，请分批导出。");
  const result=new Uint8Array(size), view=new DataView(result.buffer);
  let offset=0;
  const u16=(value:number)=>{view.setUint16(offset,value,true);offset+=2;};
  const u32=(value:number)=>{view.setUint32(offset,value,true);offset+=4;};
  const bytes=(value:Uint8Array)=>{result.set(value,offset);offset+=value.length;};
  // Fixed valid DOS timestamp (1980-01-01) makes identical exports reproducible.
  for(const file of records){
    file.offset=offset;
    u32(0x04034b50);u16(20);u16(0x0800);u16(0);u16(0);u16(33);
    u32(file.crc);u32(file.bytes.byteLength);u32(file.bytes.byteLength);
    u16(file.nameBytes.length);u16(0);bytes(file.nameBytes);bytes(file.bytes);
  }
  for(const file of records){
    u32(0x02014b50);u16(20);u16(20);u16(0x0800);u16(0);u16(0);u16(33);
    u32(file.crc);u32(file.bytes.byteLength);u32(file.bytes.byteLength);
    u16(file.nameBytes.length);u16(0);u16(0);u16(0);u16(0);u32(0);u32(file.offset);bytes(file.nameBytes);
  }
  u32(0x06054b50);u16(0);u16(0);u16(records.length);u16(records.length);u32(centralSize);u32(localSize);u16(0);
  return result;
}

const DATA_IMAGE=/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i;
const MIME_IMAGE=/^image\/(?:png|jpeg|jpg|webp|gif|avif)$/i;
export type InlineImageOptions={convertBlob?:(url:string)=>Promise<string>};
async function blobImageToDataUrl(url:string):Promise<string>{
  const response=await fetch(url);
  if(!response.ok)throw new Error("已缓存的图片无法读取，请重新提取文章。");
  const blob=await response.blob();
  if(!MIME_IMAGE.test(blob.type) || !blob.size || blob.size>10_000_000)throw new Error("已缓存的图片格式或大小不符合导出要求。");
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(new Error("图片转换失败。"));
    reader.onerror=()=>reject(new Error("图片转换失败。"));
    reader.onabort=()=>reject(new Error("图片转换已取消。"));
    reader.readAsDataURL(blob);
  });
}
/** Convert only browser-generated blob URLs; automated PDF rendering never fetches a remote image. */
export async function inlineImageSource(url:string, options:InlineImageOptions={}):Promise<string>{
  if(DATA_IMAGE.test(url))return url;
  if(!url.startsWith("blob:"))throw new Error("文章仍含未缓存的网络图片，请重新准备图片后再导出 PDF。");
  const result=await (options.convertBlob || blobImageToDataUrl)(url);
  if(!DATA_IMAGE.test(result))throw new Error("图片转换未返回支持的内嵌图片格式。");
  return result;
}
export async function inlinePrintImageSources(article:Article, options:InlineImageOptions={}):Promise<Article>{
  const template=document.createElement("template");template.innerHTML=article.html;
  const images=Array.from(template.content.querySelectorAll("img"));
  const cache=new Map<string,Promise<string>>();
  for(const img of images){
    const source=img.getAttribute("src")||"";
    if(!cache.has(source))cache.set(source,inlineImageSource(source,options));
  }
  // Resolve together so one failed conversion cannot leave an unhandled rejection.
  const urls=[...cache.keys()], values=await Promise.all(cache.values());
  const converted=new Map(urls.map((url,index)=>[url,values[index]]));
  for(const img of images){img.src=converted.get(img.getAttribute("src")||"")!;img.removeAttribute("srcset");}
  return {...article,html:template.innerHTML};
}
