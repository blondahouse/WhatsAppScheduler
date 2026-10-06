import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipientSync, chatJid } from '../src/recipients.ts';
import { Store } from '../src/store.ts';
import type { Recipient } from '../src/model.ts';

test('history with empty chats recovers personal conversation from actual messages and contact aliases', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.contacts(recipients, [{ id: '12345:7@lid', jid: '380123456789@s.whatsapp.net', name: 'Марина' }, { id: '99999@s.whatsapp.net', name: 'Телефонная книга без чата' }]);
  assert.equal(recipients.length, 0);
  sync.chats(recipients, []);
  sync.messages(recipients, [{ key: { remoteJid: '12345:2@lid', fromMe: false }, pushName: 'Другой push name', message: { conversation: 'Привет 👋' } }]);
  assert.deepEqual(recipients, [{ jid: '12345@lid', name: 'Марина', kind: 'personal' }]);
});

test('outgoing phone message adds existing chat without using the account owner push name', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.messages(recipients, [{ key: { remoteJid: '380123456789:4@s.whatsapp.net', fromMe: true }, pushName: 'Я', message: { conversation: 'Тест' } }]);
  assert.deepEqual(recipients, [{ jid: '380123456789@s.whatsapp.net', name: '+380123456789', kind: 'personal' }]);
  sync.contacts(recipients, [{ id: '380123456789@s.whatsapp.net', name: 'Marina' }]);
  assert.equal(recipients[0].name, 'Marina');
});

test('message events exclude group participants, status, broadcasts, channels and protocol notifications', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.messages(recipients, ['120363111@g.us', 'status@broadcast', '123@broadcast', '123@newsletter'].map(remoteJid => ({ key: { remoteJid }, pushName: 'Нельзя', message: { conversation: 'Hi' } })));
  sync.messages(recipients, [{ key: { remoteJid: '123@s.whatsapp.net' }, message: { protocolMessage: {} } }]);
  assert.deepEqual(recipients, []);
});

test('normalized chats preserve name across live messages, group and personal separation, and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-recipient-'));
  try {
    const path = join(directory, 'state.json'), store = new Store(path), sync = new RecipientSync();
    store.change(d => {
      sync.chats(d.recipients, [{ id: '123:2@s.whatsapp.net', name: 'Marina' }, { id: '123@c.us' }, { id: '123-456@g.us', name: 'Группа' }]);
      sync.messages(d.recipients, [{ key: { remoteJid: '123@s.whatsapp.net', fromMe: true }, message: { extendedTextMessage: { text: 'Test' } } }]);
    });
    assert.deepEqual(new Store(path).data.recipients, [{ jid: '123@s.whatsapp.net', name: 'Marina', kind: 'personal' }, { jid: '123-456@g.us', name: 'Группа', kind: 'group' }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('only valid numeric chat identifiers are admitted', () => {
  assert.equal(chatJid('123:4@lid'), '123@lid');
  assert.equal(chatJid('123-456@g.us'), '123-456@g.us');
  for (const id of ['abc@s.whatsapp.net', 'status@broadcast', '123@newsletter', undefined]) assert.equal(chatJid(id), undefined);
});
