/* ============================================================
   app.js — NV Chat 본체 (화면 · 이벤트 · 흐름 연결)
   ============================================================ */

import * as vault from './vault.js';
import { loadConfig, saveConfig, getConfig, updateConfig, applyConfig, getModelsCache, setModelsCache } from './config.js';
import * as store from './store.js';
import * as api from './api.js';
import { initMd, renderMd, renderPlain, enhanceCodeBlocks, escapeHtml } from './md.js';
import { processFiles, MAX_IMAGES } from './attachments.js';
import * as voice from './voice.js';
import { runEdit, SUGGESTIONS } from './aiassist.js';

const $ = (id) => document.getElementById(id);

const state = {
  conv: null,
  messages: [],
  attachments: [],
  models: [],
  streaming: false,
  abort: null,
  rec: null,
  recording: false,
  lastAiPatch: null,
  forceVision: false,
  bound: false,
};

/* ============================================================
   시작
   ============================================================ */

boot();

async function boot() {
  try { await store.initStore(); } catch (e) { toast('저장소를 열 수 없습니다: ' + e.message, 'err'); }
  registerSW();
  if (!window.isSecureContext) {
    setTimeout(() => toast('http 주소에서는 음성·홈화면추가·PIN 기능이 제한됩니다. localhost 또는 HTTPS(GitHub Pages)를 사용하세요.', 'err'), 1200);
  }
  if (vault.hasPin() && !vault.isUnlocked()) showLockScreen();
  else await startApp();
}

function showLockScreen() {
  const dlg = $('lockDlg');
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.showModal();
  setTimeout(() => $('pinInput').focus(), 50);

  const submit = async () => {
    const pin = $('pinInput').value.trim();
    if (!pin) return;
    $('pinMsg').textContent = '확인 중…';
    const ok = await vault.unlock(pin);
    if (ok) {
      $('pinMsg').textContent = '';
      $('pinInput').value = '';
      dlg.close();
      await startApp();
    } else {
      $('pinMsg').textContent = 'PIN 이 올바르지 않습니다';
    }
  };
  $('pinSubmit').addEventListener('click', submit);
  $('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

async function startApp() {
  await loadConfig();
  applyConfig();
  bindEvents();
  await initMd();

  await refreshConvList();
  updatePinStatus();
  updateStorageInfo();
  updateModelLabels();

  const cache = getModelsCache();
  if (cache && cache.models?.length) { state.models = cache.models; renderModelLists(); }
  if (hasApiConfig()) loadModels({ silent: true });
  else showSetupHint();

  const list = await store.listConversations();
  const lastId = localStorage.getItem('nvchat.lastConv');
  const last = list.find((c) => c.id === lastId);
  if (last) await openConversation(last.id);
  else await newConversation();
}

function showSetupHint() {
  if (localStorage.getItem('nvchat.hinted')) return;
  localStorage.setItem('nvchat.hinted', '1');
  setTimeout(() => toast('설정 → 연결에서 중계 서버 URL 을 입력하면 시작됩니다', ''), 800);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const tryReg = async () => {
    try { return await navigator.serviceWorker.register('./sw.js'); } catch { return null; }
  };
  tryReg().then((reg) => {
    if (reg) return;
    // 첫 시도 실패(네트워크 등) → 로드 완료 후 한 번 더
    window.addEventListener('load', () => { tryReg(); }, { once: true });
  });
}

/* ============================================================
   이벤트 바인딩
   ============================================================ */

function bindEvents() {
  if (state.bound) return;
  state.bound = true;

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });

  // 사이드바
  $('menuBtn').addEventListener('click', openSidebar);
  $('scrim').addEventListener('click', closeSidebar);
  $('newChatBtn').addEventListener('click', newConversation);
  $('newChatBtnTop').addEventListener('click', newConversation);
  $('convSearch').addEventListener('input', () => refreshConvList($('convSearch').value));
  $('settingsBtn').addEventListener('click', openSettings);

  // 모델
  $('modelBtn').addEventListener('click', openModelDlg);
  $('pickModelBtn').addEventListener('click', openModelDlg);
  $('modelSearch').addEventListener('input', renderModelLists);
  $('showAllModels').addEventListener('change', renderModelLists);
  $('refreshModelsBtn').addEventListener('click', () => loadModels({ force: true }));
  $('visionKeepBtn').addEventListener('click', () => {
    $('visionDlg').close();
    state.forceVision = true;
    send();
  });

  // 입력
  $('attachBtn').addEventListener('click', () => $('filePicker').click());
  $('filePicker').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []); // value 초기화 전에 복사 (FileList 는 살아있는 객체)
    e.target.value = '';
    addFiles(files);
  });
  $('input').addEventListener('input', autoGrow);
  $('input').addEventListener('keydown', onInputKey);
  $('sendBtn').addEventListener('click', send);
  $('stopBtn').addEventListener('click', () => state.abort?.abort());
  $('micBtn').addEventListener('click', toggleMic);

  // 붙여넣기 / 드래그앤드롭
  document.addEventListener('paste', onPaste);
  const row = document.querySelector('.input-row');
  row.addEventListener('dragover', (e) => e.preventDefault());
  row.addEventListener('drop', onDrop);

  // 설정 — 연결
  bindTextSetting('setRelayUrl', 'relayUrl');
  bindTextSetting('setAccessToken', 'accessToken');
  bindTextSetting('setApiKey', 'apiKey');
  bindTextSetting('setEndpoint', 'endpoint');
  $('setDirectMode').addEventListener('change', async (e) => {
    await updateConfig({ directMode: e.target.checked });
    $('directWrap').hidden = !e.target.checked;
  });
  $('testBtn').addEventListener('click', testConnection);

  // 설정 — AI
  bindTextSetting('setSystem', 'system', { trim: false });
  $('setTemp').addEventListener('input', (e) => {
    $('tempVal').textContent = Number(e.target.value).toFixed(2);
    updateConfig({ temperature: Number(e.target.value) }, { save: false });
  });
  $('setTemp').addEventListener('change', () => saveConfig());
  bindNumberSetting('setMaxTokens', 'maxTokens');
  $('setStreaming').addEventListener('change', (e) => updateConfig({ streaming: e.target.checked }));

  // 설정 — 음성
  $('setAutoTts').addEventListener('change', (e) => updateConfig({ autoTts: e.target.checked }));
  $('setTtsRate').addEventListener('input', (e) => {
    $('ttsRateVal').textContent = Number(e.target.value).toFixed(2) + '×';
    updateConfig({ ttsRate: Number(e.target.value) }, { save: false });
  });
  $('setTtsRate').addEventListener('change', () => saveConfig());
  $('setSttLang').addEventListener('change', (e) => updateConfig({ sttLang: e.target.value }));
  $('setEnterSend').addEventListener('change', (e) => updateConfig({ enterSend: e.target.checked }));

  // 설정 — AI 도우미
  SUGGESTIONS.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = s;
    chip.addEventListener('click', () => {
      $('aiEditInput').value = s;
      $('aiEditInput').focus();
    });
    $('aiChips').appendChild(chip);
  });
  $('aiApplyBtn').addEventListener('click', aiApply);
  $('aiUndoBtn').addEventListener('click', aiUndo);

  // 설정 — 꾸미기
  $('setTheme').addEventListener('change', (e) => updateConfig({ theme: e.target.value }));
  $('setAccent').addEventListener('input', (e) => updateConfig({ accent: e.target.value }, { save: false }));
  $('setAccent').addEventListener('change', () => saveConfig());
  rangeSetting('setFontSize', 'fontSize', 'fontVal', 'px');
  rangeSetting('setRadius', 'radius', 'radiusVal', 'px');
  rangeSetting('setChatWidth', 'chatWidth', 'widthVal', 'px');
  $('setDensity').addEventListener('change', (e) => updateConfig({ density: e.target.value }));
  $('setShowAvatars').addEventListener('change', (e) => updateConfig({ showAvatars: e.target.checked }));
  bindTextSetting('setTitle', 'title');
  bindTextSetting('setWelcome', 'welcome', { trim: false });
  $('setQuickPrompts').addEventListener('change', () =>
    updateConfig({ quickPrompts: lines($('setQuickPrompts').value) }));
  $('setCustomCss').addEventListener('change', (e) =>
    updateConfig({ customCss: e.target.value.replace(/@import[^;]*;?/gi, '') }));

  // 설정 — 데이터/보안
  $('exportBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importData);
  $('wipeBtn').addEventListener('click', wipeData);
  $('lockNowBtn').addEventListener('click', lockNow);
  $('pinSetBtn').addEventListener('click', setPinFlow);
  $('pinRemoveBtn').addEventListener('click', removePinFlow);

  // 단축키
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openModelDlg();
    }
  });
}

function bindTextSetting(id, key, { trim = true } = {}) {
  const el = $(id);
  el.addEventListener('change', () => {
    const v = trim ? el.value.trim() : el.value;
    updateConfig({ [key]: v });
    if (['relayUrl', 'endpoint', 'apiKey', 'accessToken'].includes(key)) updateModelLabels();
  });
}

function bindNumberSetting(id, key) {
  const el = $(id);
  el.addEventListener('change', () => {
    const v = el.value.trim();
    if (!v) return void updateConfig({ [key]: '' });
    const n = Number(v);
    if (Number.isFinite(n)) updateConfig({ [key]: Math.round(n) });
  });
}

function rangeSetting(id, key, labelId, unit = '') {
  const el = $(id);
  el.addEventListener('input', () => {
    $(labelId).textContent = el.value + unit;
    updateConfig({ [key]: Number(el.value) }, { save: false });
  });
  el.addEventListener('change', () => saveConfig());
}

function lines(s) {
  return s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
}

/* ============================================================
   상태 확인 · 표시
   ============================================================ */

function hasApiConfig() {
  const c = getConfig();
  return !!(c.directMode ? c.endpoint : c.relayUrl);
}

function openSidebar() {
  $('sidebar').classList.add('open');
  $('scrim').hidden = false;
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').hidden = true;
}

function saveLast() {
  if (state.conv) localStorage.setItem('nvchat.lastConv', state.conv.id);
}

async function updateStorageInfo() {
  const bytes = await store.estimateUsage();
  const mb = bytes / (1024 * 1024);
  $('sideStorage').textContent = mb >= 0.05 ? `저장소 ${mb.toFixed(1)}MB` : '';
}

function updateModelLabels() {
  const cfg = getConfig();
  const label = cfg.model ? shortModel(cfg.model) : '모델 선택';
  $('modelBtnLabel').textContent = label;
  $('settingsModelLabel').textContent = cfg.model || '선택된 모델 없음';
}

function shortModel(id) {
  if (!id) return '';
  const name = id.includes('/') ? id.split('/').slice(1).join('/') : id;
  return name.length > 30 ? name.slice(0, 29) + '…' : name;
}

function updatePinStatus() {
  $('pinStatus').textContent = vault.hasPin() ? '· 설정됨' : '· 설정 안 됨';
}

function updateComposer() {
  $('sendBtn').hidden = state.streaming;
  $('stopBtn').hidden = !state.streaming;
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function fmtDate(ts) {
  const d = new Date(ts || 0);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtTime(ts);
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '어제';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function toast(msg, kind = '') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 5200 : 3200);
}

/* ============================================================
   대화 목록
   ============================================================ */

async function refreshConvList(filter = '') {
  const list = await store.listConversations();
  const q = (filter || '').trim().toLowerCase();
  const shown = q ? list.filter((c) => (c.title || '').toLowerCase().includes(q)) : list;

  const box = $('convList');
  box.innerHTML = '';
  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'conv-empty';
    d.textContent = q ? '검색 결과가 없습니다' : '대화가 없습니다';
    box.appendChild(d);
    return;
  }
  for (const c of shown) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (state.conv?.id === c.id ? ' active' : '');
    item.innerHTML = `
      <div class="conv-title">${escapeHtml(c.title || '제목 없음')}</div>
      <div class="conv-date">${fmtDate(c.updatedAt)}</div>
      <div class="conv-actions">
        <button class="icon-btn" data-act="rename" title="이름 바꾸기"><svg class="ic"><use href="#i-edit"/></svg></button>
        <button class="icon-btn" data-act="del" title="삭제"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>`;
    item.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'rename') { e.stopPropagation(); renameConv(c); }
      else if (act === 'del') { e.stopPropagation(); deleteConv(c); }
      else openConversation(c.id);
    });
    box.appendChild(item);
  }
}

async function newConversation() {
  state.conv = await store.createConversation({ model: getConfig().model });
  state.messages = [];
  state.attachments = [];
  renderAll();
  await refreshConvList($('convSearch').value);
  saveLast();
  closeSidebar();
  $('input').focus();
}

async function openConversation(id) {
  const list = await store.listConversations();
  const conv = list.find((c) => c.id === id);
  if (!conv) return;
  state.conv = conv;
  state.messages = await store.getMessages(id);
  state.attachments = [];
  renderAll();
  await refreshConvList($('convSearch').value);
  saveLast();
  closeSidebar();
  $('input').focus();
}

async function renameConv(c) {
  const t = prompt('새 제목을 입력하세요', c.title || '');
  if (t == null) return;
  await store.updateConversation(c.id, { title: t.trim() || c.title });
  if (state.conv?.id === c.id) state.conv.title = t.trim() || c.title;
  await refreshConvList($('convSearch').value);
}

async function deleteConv(c) {
  if (!confirm(`"${c.title}" 대화를 삭제할까요?`)) return;
  await store.deleteConversation(c.id);
  if (state.conv?.id === c.id) await newConversation();
  else await refreshConvList($('convSearch').value);
}

/* ============================================================
   화면 렌더링
   ============================================================ */

function renderAll() {
  renderMessages();
  renderAttachStrip();
  updateComposer();
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    box.appendChild(buildEmpty());
    return;
  }
  for (const m of state.messages) box.appendChild(buildMsgEl(m));
  scrollBottom(true);
}

function buildEmpty() {
  const cfg = getConfig();
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `
    <div class="empty-logo">NV</div>
    <h1>${escapeHtml(cfg.title || 'NV Chat')}</h1>
    <p>${escapeHtml(cfg.welcome || '')}</p>
    <div class="chips"></div>`;
  const chips = wrap.querySelector('.chips');
  (cfg.quickPrompts || []).forEach((q) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => { $('input').value = q; autoGrow(); $('input').focus(); });
    chips.appendChild(b);
  });
  if (!hasApiConfig()) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.marginTop = '18px';
    p.textContent = '아직 연결이 설정되지 않았습니다.';
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.marginTop = '8px';
    b.textContent = '설정 열기';
    b.addEventListener('click', openSettings);
    p.appendChild(document.createElement('br'));
    p.appendChild(b);
    wrap.appendChild(p);
  }
  return wrap;
}

function toolBtn(icon, title, fn) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>`;
  b.addEventListener('click', fn);
  return b;
}

function buildMsgEl(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' msg-err' : '');
  el.dataset.mid = m.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + (m.role === 'assistant' ? 'ai' : '');
  avatar.textContent = m.role === 'user' ? '나' : 'AI';
  el.appendChild(avatar);

  const inner = document.createElement('div');
  inner.className = 'body';

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<span>${m.role === 'user' ? '나' : escapeHtml(shortModel(m.model))}</span><span>${fmtTime(m.ts)}</span>`;
  inner.appendChild(head);

  const atts = (m.attachments || []);
  if (atts.length) {
    const d = document.createElement('div');
    d.className = 'msg-atts';
    d.innerHTML = atts.map((a) => (a.kind === 'image'
      ? `<img src="${a.dataUrl}" alt="${escapeHtml(a.name || '')}" loading="lazy">`
      : `<span class="file-chip"><svg class="ic"><use href="#i-file"/></svg>${escapeHtml(a.name || '파일')}</span>`)).join('');
    inner.appendChild(d);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const md = document.createElement('div');
  md.className = 'md';
  if (m.streaming) md.innerHTML = renderPlain(m.text || '') + '<span class="cursor"></span>';
  else if (m.role === 'user') md.innerHTML = renderPlain(m.text || '');
  else md.innerHTML = renderMd(m.text || '');
  bubble.appendChild(md);
  inner.appendChild(bubble);
  if (!m.streaming) enhanceCodeBlocks(md);

  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  tools.appendChild(toolBtn('i-copy', '복사', async () => {
    try { await navigator.clipboard.writeText(m.text || ''); toast('복사했습니다', 'ok'); } catch { /* 무시 */ }
  }));
  if (m.role === 'assistant') {
    tools.appendChild(toolBtn('i-speaker', '읽어주기', () =>
      voice.speak(m.text, { rate: getConfig().ttsRate, lang: getConfig().sttLang })));
    tools.appendChild(toolBtn('i-refresh', '다시 생성', () => regenerate(m.id)));
  } else {
    tools.appendChild(toolBtn('i-edit', '다시 입력', () => {
      $('input').value = m.text || '';
      autoGrow();
      $('input').focus();
    }));
  }
  tools.appendChild(toolBtn('i-trash', '삭제', () => removeMsg(m.id)));
  inner.appendChild(tools);

  el.appendChild(inner);
  return el;
}

let scrollLock = false;
function scrollBottom(force) {
  const box = $('messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
  if (force || near) box.scrollTop = box.scrollHeight;
}

/* ============================================================
   첨부
   ============================================================ */

function renderAttachStrip() {
  const strip = $('attachStrip');
  strip.innerHTML = '';
  strip.hidden = state.attachments.length === 0;
  state.attachments.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'attach-item';
    item.innerHTML = a.kind === 'image'
      ? `<img src="${a.dataUrl}" alt="${escapeHtml(a.name)}">`
      : `<span class="file-chip"><svg class="ic"><use href="#i-file"/></svg>${escapeHtml(a.name)}</span>`;
    const x = document.createElement('button');
    x.className = 'att-x';
    x.title = '제거';
    x.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    x.addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachStrip(); });
    item.appendChild(x);
    strip.appendChild(item);
  });
}

async function addFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const results = await processFiles(fileList);
  for (const r of results) {
    if (r.kind === 'unsupported') { toast(r.reason, 'err'); continue; }
    if (r.kind === 'image' && state.attachments.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
      toast(`이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있어요`, 'err');
      continue;
    }
    state.attachments.push(r);
  }
  renderAttachStrip();
}

function onPaste(e) {
  const files = Array.from(e.clipboardData?.files || []);
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (imgs.length) {
    e.preventDefault();
    addFiles(imgs);
  }
}

function onDrop(e) {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
}

function slimAttachment(a) {
  if (a.kind === 'image') return { kind: 'image', name: a.name, dataUrl: a.dataUrl };
  return { kind: 'doc', name: a.name, text: a.text, truncated: !!a.truncated };
}

/* ============================================================
   전송 · 응답
   ============================================================ */

function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 170) + 'px';
}

function onInputKey(e) {
  const cfg = getConfig();
  if (e.key === 'Enter' && cfg.enterSend && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

async function send() {
  if (state.streaming) return;
  const cfg = getConfig();
  const text = $('input').value.trim();
  const atts = state.attachments.slice();
  if (!text && !atts.length) return;

  if (!cfg.model) { toast('모델을 먼저 선택하세요', 'err'); openModelDlg(); return; }
  if (!hasApiConfig()) { toast('설정 → 연결에서 중계 서버 URL 을 입력하세요', 'err'); openSettings(); return; }

  const imgs = atts.filter((a) => a.kind === 'image');
  if (imgs.length && !api.looksVisionModel(cfg.model) && !state.forceVision) {
    openVisionDlg();
    return;
  }
  state.forceVision = false;

  $('input').value = '';
  autoGrow();
  state.attachments = [];
  renderAttachStrip();

  const userMsg = await store.addMessage(state.conv.id, {
    role: 'user',
    text,
    attachments: atts.map(slimAttachment),
  });
  state.messages.push(userMsg);

  if (!state.conv.title || state.conv.title === '새 대화') {
    const t = (text || atts[0]?.name || '새 대화').slice(0, 30);
    const updated = await store.updateConversation(state.conv.id, { title: t });
    if (updated) state.conv = updated;
  }
  renderAll();
  await refreshConvList($('convSearch').value);
  await runAssistant();
}

function buildApiMessages() {
  const cfg = getConfig();
  const out = [];
  if (cfg.system) out.push({ role: 'system', content: cfg.system });
  const usable = state.messages.filter((m) =>
    (m.role === 'user' || m.role === 'assistant') && m.id !== 'streaming' && !m.error && m.text);
  for (const m of usable.slice(-24)) {
    const docs = (m.attachments || []).filter((a) => a.kind === 'doc');
    let text = m.text || '';
    if (docs.length) {
      text += '\n\n' + docs.map((d) => `📄 ${d.name}\n\`\`\`\n${d.text}\n\`\`\``).join('\n\n');
    }
    const imgs = (m.attachments || []).filter((a) => a.kind === 'image');
    if (m.role === 'user' && imgs.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: text || '첨부한 이미지를 확인해 주세요.' },
          ...imgs.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } })),
        ],
      });
    } else {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

async function runAssistant() {
  const cfg = getConfig();
  state.streaming = true;
  updateComposer();

  const temp = { id: 'streaming', role: 'assistant', text: '', model: cfg.model, streaming: true, ts: Date.now() };
  state.messages.push(temp);
  renderMessages();

  const mdEl = document.querySelector('.msg[data-mid="streaming"] .md');
  const controller = new AbortController();
  state.abort = controller;

  let content = '';
  let lastPaint = 0;
  const paint = (full) => {
    content = full;
    const now = performance.now();
    if (now - lastPaint < 90) return;
    lastPaint = now;
    if (mdEl) mdEl.innerHTML = renderPlain(content) + '<span class="cursor"></span>';
    scrollBottom(false);
  };

  try {
    const res = await api.streamChat({
      messages: buildApiMessages(),
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      signal: controller.signal,
      onDelta: (_d, full) => paint(full),
    });
    content = res.content || content;
    state.messages.pop();
    const saved = await store.addMessage(state.conv.id, {
      role: 'assistant', text: content, model: cfg.model, usage: res.usage || null,
    });
    state.messages.push(saved);
    renderAll();
    if (cfg.autoTts) voice.speak(content, { rate: cfg.ttsRate, lang: cfg.sttLang });
    maybeAutoTitle(content);
  } catch (e) {
    state.messages.pop();
    if (e.name === 'AbortError') {
      if (content) {
        const saved = await store.addMessage(state.conv.id, { role: 'assistant', text: content, model: cfg.model, stopped: true });
        state.messages.push(saved);
        toast('생성을 중지했습니다');
      }
      renderAll();
    } else {
      const msg = e?.message || String(e);
      const saved = await store.addMessage(state.conv.id, { role: 'assistant', text: '⚠️ ' + msg, model: cfg.model, error: true });
      state.messages.push(saved);
      renderAll();
      toast(msg, 'err');
    }
  } finally {
    state.streaming = false;
    state.abort = null;
    updateComposer();
    refreshConvList($('convSearch').value);
    updateStorageInfo();
  }
}

async function maybeAutoTitle(assistantText) {
  const cfg = getConfig();
  if (!cfg.autoTitle || !state.conv) return;
  const users = state.messages.filter((m) => m.role === 'user');
  const ais = state.messages.filter((m) => m.role === 'assistant' && !m.error && m.id !== 'streaming');
  if (users.length !== 1 || ais.length !== 1) return;
  try {
    const res = await api.chatOnce({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: `다음 대화의 제목을 한국어로 6단어 이내, 따옴표 없이 한 줄로만 출력하세요.\n사용자: ${(users[0].text || '').slice(0, 200)}\n도우미: ${(assistantText || '').slice(0, 200)}`,
      }],
      temperature: 0.2,
      maxTokens: 32,
    });
    const t = (res.content || '').replace(/["'\n]/g, '').trim().slice(0, 36);
    if (t) {
      const updated = await store.updateConversation(state.conv.id, { title: t });
      if (updated) state.conv = updated;
      await refreshConvList($('convSearch').value);
    }
  } catch { /* 제목 생성 실패는 무시 */ }
}

async function regenerate(id) {
  if (state.streaming) return;
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  for (const m of state.messages.slice(idx)) await store.deleteMessage(m.id);
  state.messages = state.messages.slice(0, idx);
  renderAll();
  await runAssistant();
}

async function removeMsg(id) {
  if (state.streaming) return;
  await store.deleteMessage(id);
  state.messages = state.messages.filter((m) => m.id !== id);
  renderAll();
  updateStorageInfo();
}

/* ============================================================
   음성 입력
   ============================================================ */

function toggleMic() {
  if (state.recording) {
    state.rec?.stop();
    return;
  }
  if (!voice.sttSupported()) {
    toast('이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)', 'err');
    return;
  }
  try {
    const rec = voice.createRecognition({
      lang: getConfig().sttLang,
      onPartial: (t) => { $('voiceHint').textContent = '🎤 ' + t; },
      onFinal: (t) => {
        const inp = $('input');
        inp.value = (inp.value ? inp.value.trim() + ' ' : '') + t;
        autoGrow();
      },
      onEnd: () => {
        state.recording = false;
        state.rec = null;
        $('micBtn').classList.remove('recording');
        $('voiceHint').textContent = '';
        $('voiceHint').classList.remove('rec');
      },
      onError: (msg) => toast('음성 인식: ' + msg, 'err'),
    });
    state.rec = rec;
    state.recording = true;
    $('micBtn').classList.add('recording');
    $('voiceHint').textContent = '🎤 듣는 중… 말씀하세요';
    $('voiceHint').classList.add('rec');
    rec.start();
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

/* ============================================================
   모델
   ============================================================ */

function openModelDlg() {
  renderModelLists();
  $('modelDlg').showModal();
  setTimeout(() => $('modelSearch').focus(), 60);
}

function openVisionDlg() {
  renderModelList($('visionList'), { visionOnly: true });
  $('visionDlg').showModal();
}

function renderModelLists() {
  renderModelList($('modelList'), {});
  if ($('visionDlg').open) renderModelList($('visionList'), { visionOnly: true });
}

function renderModelList(container, { visionOnly = false } = {}) {
  const q = ($('modelSearch').value || '').trim().toLowerCase();
  const showAll = $('showAllModels').checked;
  container.innerHTML = '';

  let models = state.models;
  if (visionOnly) models = models.filter((m) => api.looksVisionModel(m.id) && api.looksChatModel(m.id));
  else {
    models = models.filter((m) => showAll || api.looksChatModel(m.id));
    if (q) models = models.filter((m) => m.id.toLowerCase().includes(q));
  }

  if (!models.length) {
    container.innerHTML = '<p class="hint">모델이 없습니다. 새로고침(↻)을 눌러 목록을 불러오세요. 설정 → 연결을 먼저 확인하세요.</p>';
    return;
  }

  const groups = new Map();
  for (const m of models) {
    const g = m.owned_by || m.id.split('/')[0] || '기타';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  for (const [g, arr] of groups) {
    const h = document.createElement('div');
    h.className = 'model-group';
    h.textContent = g;
    container.appendChild(h);
    for (const m of arr) {
      const div = document.createElement('div');
      div.className = 'model-item' + (getConfig().model === m.id ? ' active' : '');
      div.innerHTML = `<span class="mi-name">${escapeHtml(m.id)}</span>` +
        (api.looksVisionModel(m.id) ? '<span class="mi-badge">이미지</span>' : '');
      div.addEventListener('click', () => chooseModel(m.id));
      container.appendChild(div);
    }
  }
}

async function chooseModel(id) {
  const wasVision = $('visionDlg').open;
  await updateConfig({ model: id });
  updateModelLabels();
  $('modelDlg').close();
  $('visionDlg').close();
  toast('모델: ' + shortModel(id), 'ok');
  renderModelLists();
  if (wasVision) send();
}

async function loadModels({ force = false, silent = false } = {}) {
  const cache = getModelsCache();
  if (!force && cache && cache.models?.length) {
    state.models = cache.models;
    renderModelLists();
    return;
  }
  try {
    if (!hasApiConfig()) throw new Error('중계 서버 URL 을 먼저 설정하세요');
    const models = await api.listModels();
    state.models = models;
    setModelsCache(models);
    renderModelLists();
    if (!silent) toast(`모델 ${models.length}개를 불러왔습니다`, 'ok');
  } catch (e) {
    if (!silent) toast(e.message || String(e), 'err');
  }
}

async function testConnection() {
  const el = $('testResult');
  el.textContent = '테스트 중… (모델 목록 + 채팅 확인)';
  try {
    const { models, ms, chat } = await api.testConnection({ model: getConfig().model });
    state.models = models;
    setModelsCache(models);
    renderModelLists();
    if (chat && chat.ok) {
      el.textContent = `✅ 성공 — 모델 ${models.length}개 · 채팅 확인(${shortModel(chat.model)}) ${ms}ms`;
      toast('연결 성공!', 'ok');
    } else if (chat && !chat.ok) {
      el.textContent = `⚠️ 모델 목록 ${models.length}개는 OK, 채팅 확인 실패: ${chat.error}`;
      toast('채팅 확인 실패 — 키/모델을 확인하세요', 'err');
    } else {
      el.textContent = `✅ 모델 ${models.length}개 (${ms}ms) — 모델을 선택하면 채팅 확인까지 합니다`;
      toast('연결 성공!', 'ok');
    }
  } catch (e) {
    el.textContent = '❌ ' + (e.message || e);
  }
}

/* ============================================================
   설정 열기 / AI 도우미 / 데이터
   ============================================================ */

function openSettings() {
  fillSettingsForm();
  $('settingsDlg').showModal();
}

function fillSettingsForm() {
  const c = getConfig();
  $('setRelayUrl').value = c.relayUrl || '';
  $('setAccessToken').value = c.accessToken || '';
  $('setApiKey').value = c.apiKey || '';
  $('setDirectMode').checked = !!c.directMode;
  $('directWrap').hidden = !c.directMode;
  $('setEndpoint').value = c.endpoint || '';
  $('setSystem').value = c.system || '';
  $('setTemp').value = c.temperature;
  $('tempVal').textContent = Number(c.temperature).toFixed(2);
  $('setMaxTokens').value = c.maxTokens || '';
  $('setStreaming').checked = !!c.streaming;
  $('setAutoTts').checked = !!c.autoTts;
  $('setTtsRate').value = c.ttsRate;
  $('ttsRateVal').textContent = Number(c.ttsRate).toFixed(2) + '×';
  $('setSttLang').value = c.sttLang;
  $('setEnterSend').checked = !!c.enterSend;
  $('setTheme').value = c.theme;
  $('setAccent').value = /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : '#4f8cff';
  $('setFontSize').value = c.fontSize;
  $('fontVal').textContent = c.fontSize + 'px';
  $('setRadius').value = c.radius;
  $('radiusVal').textContent = c.radius + 'px';
  $('setChatWidth').value = c.chatWidth;
  $('widthVal').textContent = c.chatWidth + 'px';
  $('setDensity').value = c.density;
  $('setShowAvatars').checked = c.showAvatars !== false;
  $('setTitle').value = c.title || '';
  $('setWelcome').value = c.welcome || '';
  $('setQuickPrompts').value = (c.quickPrompts || []).join('\n');
  $('setCustomCss').value = c.customCss || '';
}

async function aiApply() {
  const text = $('aiEditInput').value.trim();
  if (!text) return;
  if (!hasApiConfig() || !getConfig().model) {
    toast('연결과 모델을 먼저 설정하세요', 'err');
    openSettings();
    return;
  }
  const btn = $('aiApplyBtn');
  btn.disabled = true;
  $('aiEditResult').textContent = 'AI 가 설정을 작성하는 중…';
  try {
    const { patch, reply } = await runEdit({ text, models: state.models, model: getConfig().model });
    const keys = Object.keys(patch);
    if (!keys.length) {
      $('aiEditResult').textContent = reply || '변경할 항목을 찾지 못했습니다.';
    } else {
      const before = {};
      for (const k of keys) before[k] = getConfig()[k];
      state.lastAiPatch = before;
      await updateConfig(patch);
      fillSettingsForm();
      renderAll();
      updateModelLabels();
      $('aiUndoBtn').disabled = false;
      $('aiEditResult').textContent = (reply ? reply + ' — ' : '') + keys.join(', ') + ' 적용됨';
      toast('AI 가 사이트를 수정했습니다', 'ok');
    }
  } catch (e) {
    $('aiEditResult').textContent = '실패: ' + (e.message || e);
    toast('AI 수정 실패', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function aiUndo() {
  if (!state.lastAiPatch) return;
  await updateConfig(state.lastAiPatch);
  state.lastAiPatch = null;
  $('aiUndoBtn').disabled = true;
  fillSettingsForm();
  renderAll();
  updateModelLabels();
  $('aiEditResult').textContent = '되돌렸습니다.';
  toast('AI 수정을 되돌렸습니다', 'ok');
}

async function exportData() {
  try {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `nvchat-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('내보냈습니다', 'ok');
  } catch (e) {
    toast('내보내기 실패: ' + e.message, 'err');
  }
}

async function importData(e) {
  const file = (e.target.files || [])[0]; // File 객체 참조 확보 후 초기화
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = await store.importAll(data, { replace: false });
    await refreshConvList($('convSearch').value);
    toast(`${n}개 대화를 가져왔습니다`, 'ok');
  } catch (err) {
    toast('가져오기 실패: ' + err.message, 'err');
  }
}

async function wipeData() {
  if (!confirm('모든 대화를 삭제할까요? 되돌릴 수 없습니다.')) return;
  await store.wipeAll();
  state.conv = null;
  state.messages = [];
  await newConversation();
  toast('삭제했습니다', 'ok');
}

/* ---------- PIN ---------- */

async function setPinFlow() {
  if (!vault.isUnlocked()) return toast('먼저 잠금을 해제하세요', 'err');
  const pin = $('setPin').value.trim();
  if (!/^\d{4,8}$/.test(pin)) return toast('숫자 4~8자리로 입력하세요', 'err');
  const btn = $('pinSetBtn');
  btn.disabled = true;
  try {
    const collected = await store.collectPayloads();
    await vault.setPin(pin);
    await store.rewritePayloads(collected);
    await saveConfig();
    $('setPin').value = '';
    updatePinStatus();
    toast('PIN 을 설정했습니다. 다음 실행부터 잠깁니다.', 'ok');
  } catch (e) {
    toast('PIN 설정 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function removePinFlow() {
  if (!vault.hasPin()) return toast('PIN 이 설정되어 있지 않습니다');
  const pin = prompt('현재 PIN 을 입력하세요');
  if (pin == null) return;
  if (!(await vault.unlock(pin))) return toast('PIN 이 올바르지 않습니다', 'err');
  try {
    const collected = await store.collectPayloads();
    vault.clearPin();
    await store.rewritePayloads(collected);
    await saveConfig();
    updatePinStatus();
    toast('PIN 을 해제했습니다', 'ok');
  } catch (e) {
    toast('해제 실패: ' + e.message, 'err');
  }
}

async function lockNow() {
  if (!vault.hasPin()) return toast('PIN 을 먼저 설정하세요');
  vault.lockKey();
  location.reload();
}
