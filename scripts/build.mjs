import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
mkdirSync('assets',{recursive:true});
function crc32(buffer) { let crc=0xffffffff; for(const b of buffer) { crc ^= b; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }
function chunk(type,data) { const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]); }
const size=256, pixels=Buffer.alloc((size*4+1)*size);
for(let y=0;y<size;y++)for(let x=0;x<size;x++) { const at=y*(size*4+1)+1+x*4; const sx=x/4,sy=y/4; const ring=Math.abs(Math.hypot(sx-31.5,sy-31.5)-22)<3; const hands=(Math.abs(sx-32)<2&&sy>=16&&sy<=33)||(Math.abs(sy-32)<2&&sx>=32&&sx<=46); const dark=ring||hands;pixels[at]=pixels[at+1]=pixels[at+2]=dark?38:255;pixels[at+3]=dark?255:0; }
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
writeFileSync('assets/icon.png',png);
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=0;header[7]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);writeFileSync('assets/icon.ico',Buffer.concat([header,png]));
await build({entryPoints:['src/main.ts'],outfile:'dist/main.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:true});
await build({entryPoints:['src/preload.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
