/* ============================================================
   config.js — 앱 설정 (기본값 · 저장/불러오기 · 화면 적용)
   ============================================================ */

import * as vault from './vault.js';

const CFG_KEY = 'nvchat.config.v1';
const MODELS_KEY = 'nvchat.models.cache.v1';

export const DEFAULT_CONFIG = {
  // 연결
  relayUrl: '',
  accessToken: '',
  apiKey: '',
  directMode: false,
  endpoint: 'https://integrate.api.nvidia.com/v1',
  // AI
  model: '',
  system: '당신은 사용자에게 도움을 주는 한국어 AI 어시스턴트입니다. 정확하고 이해하기 쉽게, 친절한 말투로 답하세요.',
  temperature: 0.7,
  maxTokens: '',
  streaming: true,
  // 음성/입력
  autoTts: false,
  ttsRate: 1,
  sttLang: 'ko-KR',
  enterSend: true,
  // 화면
  theme: 'dark',
  accent: '#4f8cff',
  fontSize: 15,
  radius: 14,
  chatWidth: 820,
  density: 'comfortable',
  showAvatars: true,
  title: 'NV Chat',
  welcome: '무엇이든 물어보세요. NVIDIA 의 다양한 AI 모델과 대화할 수 있습니다.',
  quickPrompts: [
    '오늘 하루 계획을 함께 짜줘',
    '이 문장을 영어로 자연스럽게 번역해줘: ',
    '초보자도 할 수 있는 요리 하나 알려줘',
  ],
  customCss: '',
  // 기타
  autoTitle: true,
};

let cfg = { ...DEFAULT_CONFIG };

export function getConfig() {
  return cfg;
}

export async function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const json = await vault.open(raw);
      cfg = { ...DEFAULT_CONFIG, ...JSON.parse(json) };
    }
  } catch (e) {
    console.warn('설정을 불러오지 못했습니다(새로 시작합니다).', e);
    cfg = { ...DEFAULT_CONFIG };
  }
  return cfg;
}

export async function saveConfig() {
  localStorage.setItem(CFG_KEY, await vault.seal(JSON.stringify(cfg)));
}

export async function updateConfig(patch, { save = true, apply = true } = {}) {
  Object.assign(cfg, patch);
  if (apply) applyConfig();
  if (save) await saveConfig();
  return cfg;
}

/** 설정을 실제 화면(CSS 변수·제목·사용자 CSS)에 반영 */
export function applyConfig() {
  const el = document.documentElement;
  el.dataset.theme = cfg.theme === 'light' ? 'light' : 'dark';
  el.dataset.density = cfg.density === 'compact' ? 'compact' : 'comfortable';
  el.style.setProperty('--accent', cfg.accent || '#4f8cff');
  el.style.setProperty('--font-size', (cfg.fontSize || 15) + 'px');
  el.style.setProperty('--radius', (cfg.radius ?? 14) + 'px');
  el.style.setProperty('--chat-width', (cfg.chatWidth || 820) + 'px');

  const title = cfg.title || 'NV Chat';
  document.title = title;
  const brand = document.getElementById('brandTitle');
  if (brand) brand.textContent = title;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = cfg.theme === 'light' ? '#f5f6f8' : '#0f1115';

  let userCss = document.getElementById('userCss');
  if (!userCss) {
    userCss = document.createElement('style');
    userCss.id = 'userCss';
    document.head.appendChild(userCss);
  }
  userCss.textContent = cfg.customCss || '';

  document.body.classList.toggle('hide-avatars', cfg.showAvatars === false);
}

/* ---------- 모델 목록 캐시 (민감 정보 아님 → 평문) ---------- */

export function getModelsCache() {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return null;
    return data;
  } catch {
    return null;
  }
}

export function setModelsCache(models) {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify({ models, fetchedAt: Date.now() }));
  } catch { /* 용량 초과 등은 무시 */ }
}
