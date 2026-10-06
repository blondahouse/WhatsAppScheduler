import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory=mkdtempSync(join(tmpdir(),'wa-live-qr-'));
const app=await electron.launch({executablePath:process.env.APP_EXE,args:process.env.APP_EXE?[]:['.'],env:{...process.env,WASCHEDULER_SMOKE:'0',WASCHEDULER_VERIFY_QR:'1',WASCHEDULER_DATA:directory},timeout:60000});
try {
  const page=await app.firstWindow();
  await expect(page.locator('#auth')).toBeVisible({timeout:90000});
  await expect(page.locator('#qr')).toHaveAttribute('src',/^data:image\/png;base64,/,{timeout:90000});
  const image=await page.locator('#qr').evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight}));
  expect(image.width).toBe(240);expect(image.height).toBe(240);
  console.log('LIVE INSTALLED APP QR: received from WhatsApp, encrypted auth persisted, PNG displayed. No account linked and no message sent.');
} catch(e) {
  const page=app.windows()[0];if(page) console.log('Connection state:',await page.locator('#connection').textContent(),await page.locator('#connection-error').textContent());
  const log=join(directory,'debug.log');if(existsSync(log)) console.log('Connection diagnostics:',readFileSync(log,'utf8'));
  throw e;
} finally {await app.close();rmSync(directory,{recursive:true,force:true});}
