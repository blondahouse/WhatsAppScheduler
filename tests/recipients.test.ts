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

test('names follow stable priority across partial updates and message events', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.messages(recipients, [{ key: { remoteJid: '123@lid' }, pushName: 'Message name', message: { conversation: 'Hi' } }]);
  assert.equal(recipients[0].name, 'Message name');
  sync.contacts(recipients, [{ id: '123@lid', notify: 'Profile', verifiedName: 'Business' }]);
  assert.equal(recipients[0].name, 'Business');
  sync.chats(recipients, [{ id: '123@lid', name: 'Chat title' }]);
  assert.equal(recipients[0].name, 'Chat title');
  sync.contacts(recipients, [{ id: '123@lid', name: '  Saved contact  ' }]);
  sync.contacts(recipients, [{ id: '123@lid', name: ' ', notify: 'Other profile' }]);
  sync.messages(recipients, [{ key: { remoteJid: '123@lid' }, pushName: 'Other push', message: { conversation: 'Hi' } }]);
  assert.equal(recipients[0].name, 'Saved contact');
});

test('whitespace and technical IDs do not block readable lower-priority names', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.contacts(recipients, [{ id: '123@lid', name: ' ', notify: 'Profile' }]);
  sync.chats(recipients, [{ id: '123@lid', name: '123@lid' }]);
  assert.equal(recipients[0].name, 'Profile');
});

test('LID fallback is not presented as a phone number; explicit aliases supply phone fallback', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.chats(recipients, [{ id: '987654321@lid' }]);
  assert.equal(recipients[0].name, 'Unnamed chat · …4321');
  sync.contacts(recipients, [{ id: '987654321@lid', jid: '380123456789@s.whatsapp.net' }]);
  assert.equal(recipients[0].name, '+380123456789');
});

test('message alternate address finds saved contact without changing the sending JID', () => {
  const sync = new RecipientSync(), recipients: Recipient[] = [];
  sync.contacts(recipients, [{ id: '380123456789@s.whatsapp.net', name: 'Марина 🌸' }]);
  sync.messages(recipients, [{ key: { remoteJid: '123@lid', remoteJidAlt: '380123456789@s.whatsapp.net' }, message: { conversation: 'Hi' } }]);
  assert.deepEqual(recipients, [{ jid: '123@lid', name: 'Марина 🌸', kind: 'personal' }]);
});

test('name sources and aliases persist across restart and remain higher priority than partial updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-name-'));
  try {
    const path = join(directory, 'state.json'), store = new Store(path), sync = new RecipientSync();
    store.change(d => {
      sync.contacts(d.recipients, [{ id: '123@lid', jid: '380123456789@s.whatsapp.net', name: 'Saved contact' }]);
      sync.chats(d.recipients, [{ id: '123@lid' }]);
      d.recipientMetadata = sync.metadata;
    });
    const restored = new Store(path), resumed = new RecipientSync(restored.data.recipientMetadata);
    resumed.contacts(restored.data.recipients, [{ id: '380123456789@s.whatsapp.net', notify: 'Lower priority' }]);
    assert.equal(restored.data.recipients[0].name, 'Saved contact');
    resumed.clear();
    assert.deepEqual(resumed.metadata, {});
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
