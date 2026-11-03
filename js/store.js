/* ============================================================
   store.js — 대화/메시지 저장소 (IndexedDB + vault 암호화)
   ============================================================ */

import * as vault from './vault.js';

const DB_NAME = 'nvchat';
const DB_VER = 1;
let db = null;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function initStore() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('conversations')) {
        d.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('messages')) {
        const ms = d.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('convId', 'convId');
      }
    };
    r.onsuccess = () => { db = r.result; resolve(db); };
    r.onerror = () => reject(r.error);
  });
}

async function put(storeName, value) {
  const d = await initStore();
  const t = d.transaction(storeName, 'readwrite');
  t.objectStore(storeName).put(value);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
  });
}

async function getRow(storeName, key) {
  const d = await initStore();
  const t = d.transaction(storeName, 'readonly');
  return request(t.objectStore(storeName).get(key));
}

async function del(storeName, key) {
  const d = await initStore();
  const t = d.transaction(storeName, 'readwrite');
  t.objectStore(storeName).delete(key);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function getAll(storeName, indexName, value) {
  const d = await initStore();
  const t = d.transaction(storeName, 'readonly');
  const store = t.objectStore(storeName);
  const req = indexName ? store.index(indexName).getAll(value) : store.getAll();
  return request(req);
}

/* ---------------- 대화 ---------------- */

export async function listConversations() {
  const rows = await getAll('conversations');
  const list = [];
  for (const row of rows) {
    try {
      const meta = JSON.parse(await vault.open(row.payload));
      list.push({ id: row.id, updatedAt: row.updatedAt || 0, ...meta });
    } catch { /* 열 수 없는 기록은 생략 */ }
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createConversation({ title = '새 대화', model = '' } = {}) {
  const id = uid();
  const now = Date.now();
  const meta = { title, model, createdAt: now, pinned: false };
  await put('conversations', {
    id,
    updatedAt: now,
    nextSeq: 1,
    payload: await vault.seal(JSON.stringify(meta)),
  });
  return { id, updatedAt: now, ...meta };
}

export async function updateConversation(id, patch) {
  const row = await getRow('conversations', id);
  if (!row) return null;
  const meta = JSON.parse(await vault.open(row.payload));
  Object.assign(meta, patch);
  row.payload = await vault.seal(JSON.stringify(meta));
  row.updatedAt = Date.now();
  await put('conversations', row);
  return { id, updatedAt: row.updatedAt, ...meta };
}

export async function touchConversation(id) {
  const row = await getRow('conversations', id);
  if (!row) return;
  row.updatedAt = Date.now();
  await put('conversations', row);
}

export async function deleteConversation(id) {
  const msgs = await getAll('messages', 'convId', id);
  for (const m of msgs) await del('messages', m.id);
  await del('conversations', id);
}

/* ---------------- 메시지 ---------------- */

export async function addMessage(convId, msg) {
  const conv = await getRow('conversations', convId);
  const seq = conv ? (conv.nextSeq || 1) : Date.now();
  const now = Date.now();
  const id = uid();
  const data = { ...msg, ts: msg.ts || now };
  await put('messages', {
    id,
    convId,
    seq,
    payload: await vault.seal(JSON.stringify(data)),
  });
  if (conv) {
    conv.nextSeq = seq + 1;
    conv.updatedAt = now;
    await put('conversations', conv);
  }
  return { id, seq, ...data };
}

export async function updateMessage(id, patch) {
  const row = await getRow('messages', id);
  if (!row) return null;
  const data = JSON.parse(await vault.open(row.payload));
  Object.assign(data, patch);
  row.payload = await vault.seal(JSON.stringify(data));
  await put('messages', row);
  const conv = await getRow('conversations', row.convId);
  if (conv) { conv.updatedAt = Date.now(); await put('conversations', conv); }
  return { id, seq: row.seq, ...data };
}

export async function deleteMessage(id) {
  const row = await getRow('messages', id);
  if (row) {
    await del('messages', id);
    await touchConversation(row.convId);
  }
}

export async function getMessages(convId) {
  const rows = await getAll('messages', 'convId', convId);
  const out = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(await vault.open(row.payload));
      out.push({ id: row.id, seq: row.seq, ...data });
    } catch { /* 생략 */ }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/* ---------------- 내보내기 / 가져오기 / 초기화 ---------------- */

export async function exportAll() {
  const convs = await listConversations();
  const data = { app: 'NV Chat', version: 1, exportedAt: new Date().toISOString(), conversations: [] };
  for (const c of convs) {
    const messages = await getMessages(c.id);
    data.conversations.push({ ...c, messages });
  }
  return data;
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || !Array.isArray(data.conversations)) throw new Error('형식이 올바르지 않습니다');
  if (replace) await wipeAll();
  let count = 0;
  for (const c of data.conversations) {
    const meta = { title: c.title || '가져온 대화', model: c.model || '', createdAt: c.createdAt || Date.now(), pinned: !!c.pinned };
    const id = uid();
    await put('conversations', { id, updatedAt: Date.now(), nextSeq: 1, payload: await vault.seal(JSON.stringify(meta)) });
    for (const m of (c.messages || [])) {
      await addMessage(id, {
        role: m.role || 'user',
        text: m.text || '',
        attachments: m.attachments || [],
        model: m.model || '',
        usage: m.usage || null,
        error: m.error || false,
        ts: m.ts || Date.now(),
      });
    }
    count++;
  }
  return count;
}

export async function wipeAll() {
  await initStore();
  for (const s of ['messages', 'conversations']) {
    await new Promise((resolve, reject) => {
      const t = db.transaction(s, 'readwrite');
      t.objectStore(s).clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }
}

export async function estimateUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      return usage || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

/* ---------------- PIN 모드 전환용 ---------------- */

export async function collectPayloads() {
  const out = { conversations: [], messages: [] };
  for (const s of ['conversations', 'messages']) {
    const rows = await getAll(s);
    for (const row of rows) {
      out[s].push({ row, plain: await vault.open(row.payload) });
    }
  }
  return out;
}

export async function rewritePayloads(collected) {
  for (const s of ['conversations', 'messages']) {
    for (const { row, plain } of collected[s]) {
      row.payload = await vault.seal(plain);
      await put(s, row);
    }
  }
}
