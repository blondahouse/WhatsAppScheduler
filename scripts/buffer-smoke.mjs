// Exercise the shipped Baileys event buffer, not a mock of its implementation.
import { makeEventBuffer } from '@whiskeysockets/baileys';
import pino from 'pino';
import assert from 'node:assert/strict';
import { recoverStalledEvents } from '../src/sync-health.ts';
import { RecipientSync } from '../src/recipients.ts';

const ev = makeEventBuffer(pino({ level: 'silent' })), sync = new RecipientSync(), recipients = [];
let messages = 0;
ev.on('messages.upsert', event => { messages += event.messages.length; sync.messages(recipients, event.messages); });
ev.buffer();
ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '123456@s.whatsapp.net', id: 'fixture', fromMe: false }, messageTimestamp: 1, pushName: 'Fixture chat', message: { conversation: 'Fixture' } }] });
assert.equal(messages, 0); assert.equal(recipients.length, 0);
assert.equal(recoverStalledEvents(ev, false, 44999), false); assert.equal(messages, 0);
assert.equal(recoverStalledEvents(ev, false, 60000), true);
assert.equal(messages, 1); assert.equal(recipients[0].kind, 'personal');
assert.equal(recipients[0].name, 'Fixture chat');
assert.equal(recoverStalledEvents(ev, false, 90000), false); assert.equal(messages, 1);
console.log('Real Baileys initial-buffer regression: queued personal message released once; healthy session left unchanged.');
