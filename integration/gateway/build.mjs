import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const mime={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.mjs':'text/javascript;charset=utf-8','.js':'text/javascript;charset=utf-8','.json':'application/json;charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const assets={};
function visit(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){if(ent.name==='server'||ent.name==='client'||ent.name==='.openai')continue;const file=path.join(dir,ent.name);if(ent.isSymbolicLink())throw new Error('No symlinks');if(ent.isDirectory()){visit(file);continue;}const bytes=fs.readFileSync(file);const name='/'+path.relative('dist',file).replaceAll('\\','/');assets[name]={type:mime[path.extname(file)]||'application/octet-stream',hash:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')};}}
visit('dist');
// A small static portfolio is embedded byte-for-byte; application code is remote.
const source=fs.readFileSync('gateway/index.mjs','utf8').replace("import { forwardToApplication,PREFIX } from './bridge.mjs';",'').replace("import assets from './assets.generated.mjs';",'');
const bridge=fs.readFileSync('gateway/bridge.mjs','utf8').replace(/^import .*;\r?\n/m,'').replaceAll('export ','');
const primitives="const b64=b=>btoa(String.fromCharCode(...b)); const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)); async function sha(v){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof v==='string'?new TextEncoder().encode(v):v))].map(b=>b.toString(16).padStart(2,'0')).join('');}";
fs.mkdirSync('dist/server',{recursive:true});
fs.writeFileSync('dist/server/index.js',primitives+'\n'+bridge+'\nconst assets='+JSON.stringify(assets)+';\n'+source);
fs.mkdirSync('dist/.openai',{recursive:true});fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
fs.writeFileSync('gateway/static-hashes.json',JSON.stringify(Object.fromEntries(Object.entries(assets).map(([p,v])=>[p,v.hash])),null,2)+'\n');
console.log('Gateway built; '+Object.keys(assets).length+' static files preserved byte-for-byte.');
