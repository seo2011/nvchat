/* ============================================================
   aiassist.js — "말로 사이트 바꾸기"
   자연어 요청 → 검증된 설정 patch → 즉시 화면 반영
   ============================================================ */

import { chatOnce } from './api.js';
import { getConfig } from './config.js';

export const EDIT_SCHEMA = {
  theme: { type: 'string', enum: ['dark', 'light'], desc: '테마' },
  accent: { type: 'string', desc: '강조 색 HEX(#rrggbb)' },
  fontSize: { type: 'number', min: 13, max: 20, integer: true, desc: '글자 크기 px' },
  radius: { type: 'number', min: 0, max: 24, integer: true, desc: '모서리 둥글기 px' },
  chatWidth: { type: 'number', min: 600, max: 1100, integer: true, desc: '채팅 영역 폭 px' },
  density: { type: 'string', enum: ['comfortable', 'compact'], desc: '화면 밀도' },
  showAvatars: { type: 'boolean', desc: '프로필 아이콘 표시' },
  title: { type: 'string', max: 40, desc: '앱 이름' },
  welcome: { type: 'string', max: 200, desc: '빈 화면 시작 인사말' },
  quickPrompts: { type: 'string[]', maxItems: 6, desc: '빠른 질문 목록' },
  customCss: { type: 'string', max: 2000, desc: '추가 CSS (@import 금지)' },
  system: { type: 'string', max: 2000, desc: 'AI 시스템 프롬프트(전체 교체 — 말투/성격 지정)' },
  temperature: { type: 'number', min: 0, max: 2, desc: '창의성(온도)' },
  maxTokens: { type: 'number', min: 16, max: 128000, integer: true, desc: '최대 응답 토큰' },
  streaming: { type: 'boolean', desc: '스트리밍 응답' },
  autoTts: { type: 'boolean', desc: '답변 자동 읽기' },
  ttsRate: { type: 'number', min: 0.5, max: 1.5, desc: '읽기 속도' },
  sttLang: { type: 'string', enum: ['ko-KR', 'en-US', 'ja-JP', 'zh-CN'], desc: '음성 인식 언어' },
  enterSend: { type: 'boolean', desc: 'Enter 로 전송' },
  model: { type: 'string', desc: '모델 ID (제공된 목록의 정확한 id 만)' },
};

export const SUGGESTIONS = [
  '밝은 테마로 바꿔줘',
  '포인트 색을 보라색으로 바꿔줘',
  '답변을 짧고 친근하게 해줘',
  '글자를 크게, 촘촘한 밀도로 바꿔줘',
  '시작 인사말과 빠른 질문 4개를 추천해줘',
];

function schemaDescription() {
  return Object.entries(EDIT_SCHEMA).map(([k, v]) => {
    let t = v.type;
    if (v.enum) t += ` (${v.enum.join(' | ')})`;
    if (v.type === 'number') t += ` ${v.min}~${v.max}`;
    if (v.max) t += ` 최대 ${v.max}자`;
    if (v.integer) t += ' 정수';
    return `- ${k}: ${t} — ${v.desc || ''}`;
  }).join('\n');
}

function parseJsonLoose(text) {
  const src = String(text || '').trim();
  const candidates = [];
  candidates.push(src);
  const fence = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const first = src.indexOf('{');
  const last = src.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(src.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 다음 후보 */ }
  }
  return null;
}

export function validatePatch(patch, models = []) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const spec = EDIT_SCHEMA[k];
    if (!spec) continue;
    if (spec.type === 'number') {
      let n = Number(v);
      if (!Number.isFinite(n)) continue;
      n = Math.min(spec.max, Math.max(spec.min, n));
      if (spec.integer) n = Math.round(n);
      out[k] = n;
    } else if (spec.type === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
    } else if (spec.type === 'string[]') {
      if (Array.isArray(v)) {
        out[k] = v.map((x) => String(x).trim()).filter(Boolean).slice(0, spec.maxItems || 8);
      }
    } else if (spec.type === 'string') {
      let s = String(v).trim();
      if (!s) continue;
      if (spec.enum && !spec.enum.includes(s)) continue;
      if (k === 'accent' && !/^#[0-9a-f]{6}$/i.test(s)) continue;
      if (k === 'customCss') s = s.replace(/@import[^;]*;?/gi, '').slice(0, 2000);
      if (spec.max) s = s.slice(0, spec.max);
      out[k] = s;
    }
  }
  if (out.model && !models.some((m) => m.id === out.model)) delete out.model;
  return out;
}

/**
 * 자연어 편집 실행 → { patch, reply }
 */
export async function runEdit({ text, models = [], model }) {
  const cfg = getConfig();
  const current = {};
  for (const k of Object.keys(EDIT_SCHEMA)) current[k] = cfg[k];

  const modelIds = models.map((m) => m.id).slice(0, 150).join(', ');
  const system = `너는 웹앱 "NV Chat"의 설정 편집기다. 사용자의 자연어 요청을 아래 설정 항목에 반영해 JSON 으로만 답한다.

규칙:
1) 출력은 JSON 하나만: {"patch": {...}, "reply": "한국어 한 줄 요약"}
2) patch 에는 실제로 바꿀 항목만 담는다. 바꿀 게 없으면 {}.
3) 문구(title, welcome, quickPrompts, system)는 사용자 의도에 맞게 자연스럽게 직접 작성한다.
4) customCss 는 @import 금지. model 은 아래 목록의 정확한 id 만 사용한다.
5) 목록에 없는 키는 넣지 않는다. 형식을 반드시 지킨다.

편집 가능한 설정:
${schemaDescription()}

모델 목록: ${modelIds || '(없음)'}

현재 설정(JSON):
${JSON.stringify(current)}`;

  const res = await chatOnce({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    temperature: 0.2,
    maxTokens: 800,
  });

  const parsed = parseJsonLoose(res.content);
  if (!parsed) throw new Error('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.');
  const patch = validatePatch(parsed.patch, models);
  const reply = String(parsed.reply || '').slice(0, 200);
  return { patch, reply };
}
