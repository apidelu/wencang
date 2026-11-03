import {fileURLToPath} from 'node:url';
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const tests=readdirSync(new URL('../tests/',import.meta.url)).filter(n=>n.endsWith('.test.mjs')).map(n=>fileURLToPath(new URL('../tests/'+n,import.meta.url)));
const result=spawnSync(process.execPath,['--experimental-strip-types','--test',...tests],{stdio:'inherit'});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??1);
