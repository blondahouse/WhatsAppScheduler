import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const p = JSON.parse(readFileSync('package.json','utf8'));
for (const kind of ['dependencies','devDependencies']) for (const name of Object.keys(p[kind])) {
  if (p[kind][name] !== 'latest') continue;
  const version = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view',name,'version'],{encoding:'utf8',shell:process.platform === 'win32'}).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected stable semver for ${name}: ${version}`);
  p[kind][name] = version;
  console.log(`${name}: ${version}`);
}
writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
