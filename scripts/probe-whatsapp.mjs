// Account-free live handshake: request a QR, never scan/link or send a message.
import makeWASocket, { initAuthCreds, Browsers, fetchLatestBaileysVersion, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
async function probe(label, version, fullHistory = false) {
  return await new Promise(resolve => {
    let socket, timer, done = false;
    const finish = result => { if(done) return;done=true;clearTimeout(timer);socket?.end(undefined);resolve({label,version:version||'bundled',...result}); };
    try {
      const keys = {};
      socket = makeWASocket({ ...(version ? { version } : {}), auth: { creds:initAuthCreds(), keys:{get:async(type,ids)=>Object.fromEntries(ids.filter(id=>keys[`${type}:${id}`]).map(id=>[id,keys[`${type}:${id}`]])),set:async data=>{for(const [type,values] of Object.entries(data))for(const [id,value] of Object.entries(values))keys[`${type}:${id}`]=value;} } },logger:pino({level:'silent'}),browser:Browsers.windows('Desktop'),syncFullHistory:fullHistory,connectTimeoutMs:25000,defaultQueryTimeoutMs:25000,markOnlineOnConnect:false });
      socket.ev.on('connection.update',u=> {
        if(u.qr) finish({qr:true});
        if(u.connection==='close')finish({qr:false,code:u.lastDisconnect?.error?.output?.statusCode,message:u.lastDisconnect?.error?.message});
      });
      timer=setTimeout(()=>finish({qr:false,message:'QR handshake timeout'}),35000);
    } catch(e) { finish({qr:false,message:e.message}); }
  });
}
console.log(JSON.stringify(await probe('app-full-history',undefined,true)));
const bundled=await probe('bundled');console.log(JSON.stringify(bundled));
const latest=await fetchLatestBaileysVersion({timeout:10000});console.log(JSON.stringify({source:'Baileys current version',version:latest.version,isLatest:latest.isLatest}));
console.log(JSON.stringify(await probe('current',latest.version)));
if(!bundled.qr) {
  const web=await fetchLatestWaWebVersion({timeout:10000});console.log(JSON.stringify({source:'WhatsApp web version',version:web.version,isLatest:web.isLatest}));
  if(web.isLatest)console.log(JSON.stringify(await probe('WhatsApp current',web.version)));
}
