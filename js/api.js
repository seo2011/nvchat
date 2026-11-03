/* ============================================================
   api.js — NVIDIA NIM API 클라이언트 (중계/직접 연결)
   ============================================================ */

import { getConfig } from './config.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

function baseUrl() {
  const c = getConfig();
  if (c.directMode) {
    const ep = (c.endpoint || '').trim().replace(/\/+$/, '');
    if (!ep) throw new ApiError('엔드포인트가 설정되지 않았습니다 (설정 → 연결)');
    return { url: ep, pathMode: 'direct' };
  }
  const relay = (c.relayUrl || '').trim().replace(/\/+$/, '');
  if (!relay) throw new ApiError('중계 서버 URL이 설정되지 않았습니다 (설정 → 연결)');
  return { url: relay, pathMode: 'relay' };
}

function buildUrl(path) {
  const { url, pathMode } = baseUrl();
  if (pathMode === 'direct') return url + path.replace(/^\/v1/, '');
  return url + path; // 중계 서버는 /v1/... 경로를 그대로 전달
}

function headers(json = true) {
  const c = getConfig();
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (c.apiKey) h['Authorization'] = 'Bearer ' + c.apiKey;
  if (!c.directMode && c.accessToken) h['X-Access-Token'] = c.accessToken;
  return h;
}

function friendlyError(status, body) {
  let msg = '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    msg = j?.error?.message || j?.detail || j?.message || '';
  } catch { msg = typeof body === 'string' ? body.slice(0, 200) : ''; }
  switch (status) {
    case 401: return '인증 실패(401): API 키를 확인하세요. 중계 서버에 키를 저장했다면 Worker 설정도 확인하세요.' + (msg ? ' — ' + msg : '');
    case 403: return '인증 거부(403): API 키가 올바른지, 사용 권한이 있는지 확인하세요.' + (msg ? ' — ' + msg : '');
    case 404: return '찾을 수 없음(404): 모델 이름이나 중계 주소를 확인하세요.' + (msg ? ' — ' + msg : '');
    case 429: return '요청 한도 초과(429): 잠시 후 다시 시도하세요.' + (msg ? ' — ' + msg : '');
    default:
      if (status >= 500) return `서버 오류(${status})` + (msg ? ' — ' + msg : '');
      return `요청 실패(${status})` + (msg ? ' — ' + msg : '');
  }
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  return new ApiError(friendlyError(res.status, text), res.status);
}

/* ---------------- 모델 목록 ---------------- */

export async function listModels() {
  let res;
  try {
    res = await fetch(buildUrl('/v1/models'), { headers: headers(false) });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('연결에 실패했습니다. 중계 서버 URL과 네트워크를 확인하세요.');
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const models = (data.data || [])
    .map((m) => ({ id: m.id, owned_by: m.owned_by || '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/**
 * 연결 테스트: 모델 목록 + 실제 채팅 1회(아주 짧게)로 키 유효성까지 확인
 * (/v1/models 는 인증 없이도 열려 있어서 목록만으로는 키를 검증할 수 없음)
 */
export async function testConnection({ model } = {}) {
  const started = Date.now();
  const models = await listModels();
  const cfg = getConfig();
  const probe = model || cfg.model || models.find((m) => looksChatModel(m.id))?.id;
  let chat = null;
  if (probe) {
    try {
      const res = await chatOnce({
        model: probe,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 4,
        temperature: 0,
      });
      chat = { ok: true, model: probe, sample: (res.content || '').slice(0, 40) };
    } catch (e) {
      chat = { ok: false, model: probe, error: e.message || String(e) };
    }
  }
  return { models, ms: Date.now() - started, chat };
}

/* ---------------- 채팅 (스트리밍) ---------------- */

/**
 * messages: [{role, content}] — content 는 문자열 또는 OpenAI 비전 형식 배열
 * onDelta(textChunk), onDone({content, usage}), signal(AbortSignal)
 */
export async function streamChat({ messages, model, temperature, maxTokens, signal, onDelta }) {
  const c = getConfig();
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    stream: true,
  };
  if (maxTokens) body.max_tokens = Number(maxTokens);

  let res;
  try {
    res = await fetch(buildUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof ApiError) throw e;
    throw new ApiError('연결에 실패했습니다. 중계 서버 URL과 네트워크를 확인하세요.');
  }
  if (!res.ok) throw await readError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        const reasonDelta = json.choices?.[0]?.delta?.reasoning_content || json.choices?.[0]?.delta?.reasoning;
        if (typeof delta === 'string' && delta) {
          content += delta;
          if (onDelta) onDelta(delta, content);
        } else if (typeof reasonDelta === 'string' && reasonDelta && onDelta) {
          onDelta('', content, reasonDelta);
        }
        if (json.usage) usage = json.usage;
      } catch { /* 조각난 JSON 은 다음 버퍼에서 */ }
    }
  }
  return { content, usage };
}

/** 단발성(비스트리밍) 호출 — 제목 생성·AI 도우미용 */
export async function chatOnce({ messages, model, temperature = 0.3, maxTokens = 512, signal }) {
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  let res;
  try {
    res = await fetch(buildUrl('/v1/chat/completions'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof ApiError) throw e;
    throw new ApiError('연결에 실패했습니다. 중계 서버 URL과 네트워크를 확인하세요.');
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return { content: msg.content || '', reasoning: msg.reasoning_content || '', usage: data.usage || null };
}

/* ---------------- 비전 지원 추정 ---------------- */

const VISION_HINTS = [
  'vision', 'vila', 'neva', 'llava', 'kosmos', 'fuyu', 'deplot',
  '-vl', 'vl-', 'visual', 'multimodal', 'image', 'cosmos-reason', 'omni',
];

export function looksVisionModel(id) {
  const s = (id || '').toLowerCase();
  return VISION_HINTS.some((h) => s.includes(h));
}

/** 채팅에 부적합한(임베딩/가드/파서 등) 모델인지 */
const NON_CHAT_HINTS = [
  'embed', 'rerank', 'reward', 'guard', 'safety', 'nemoguard', 'content-safety',
  'parse', 'nvclip', 'clip',
];

export function looksChatModel(id) {
  const s = (id || '').toLowerCase();
  return !NON_CHAT_HINTS.some((h) => s.includes(h));
}
