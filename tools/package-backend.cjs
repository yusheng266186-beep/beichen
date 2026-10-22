'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=process.argv[2]&&path.resolve(process.argv[2]);
if(!output||!output.endsWith('.zip')||output===root||output.startsWith(root+path.sep))throw Error('Usage: node tools/package-backend.cjs /private/path/outside-checkout/backend.zip');
if(!fs.existsSync(path.join(root,'node_modules/redis')))throw Error('Run npm ci --omit=dev before packaging.');
cp.execFileSync(process.env.PYTHON||'python3',['-c','import pathlib,zipfile\nr=pathlib.Path('+JSON.stringify(root)+')\nwith zipfile.ZipFile('+JSON.stringify(output)+',"w",zipfile.ZIP_DEFLATED) as z:\n for p in sorted(r.rglob("*")):\n  n=p.relative_to(r)\n  if not p.is_file() or not (len(n.parts)==1 and (p.suffix in (".js",".json") or p.name=="scf_bootstrap") or n.parts[0] in ("official","node_modules")):continue\n  info=zipfile.ZipInfo(n.as_posix());info.create_system=3;info.external_attr=(0o755 if p.name=="scf_bootstrap" else 0o644)<<16;z.writestr(info,p.read_bytes())\n']);fs.chmodSync(output,0o600);console.log(JSON.stringify({output,bytes:fs.statSync(output).size}));
