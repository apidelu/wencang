import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const dir=path.resolve('dist');
let html=readFileSync(path.join(dir,'index.html'),'utf8');
html=html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,(_,src)=>`<script type="module" src="data:text/javascript;base64,${readFileSync(path.join(dir,src)).toString('base64')}"></script>`);
html=html.replace(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g,(_,src)=>`<style>${readFileSync(path.join(dir,src),'utf8')}</style>`);
writeFileSync('../index.html',html);
console.log('Updated ../index.html');
