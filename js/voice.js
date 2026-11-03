/* ============================================================
   voice.js — 음성 입력(Web Speech Recognition) + 읽어주기(TTS)
   ============================================================ */

export function sttSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createRecognition({ lang = 'ko-KR', onPartial, onFinal, onEnd, onError } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('음성 인식을 지원하지 않는 브라우저입니다');
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const t = (r[0]?.transcript || '').trim();
        if (t && onFinal) onFinal(t);
      } else {
        interim += r[0]?.transcript || '';
      }
    }
    if (interim && onPartial) onPartial(interim.trim());
  };
  rec.onerror = (e) => {
    const map = {
      'not-allowed': '마이크 권한이 거부되었습니다',
      'no-speech': '음성이 감지되지 않았습니다',
      'audio-capture': '마이크를 찾을 수 없습니다',
      network: '네트워크 오류',
    };
    if (onError) onError(map[e.error] || e.error);
  };
  rec.onend = () => { if (onEnd) onEnd(); };
  return rec;
}

/* ---------------- TTS ---------------- */

export function ttsSupported() {
  return 'speechSynthesis' in window;
}

export function speak(text, { rate = 1, lang = 'ko-KR' } = {}) {
  if (!ttsSupported()) return false;
  const clean = stripForSpeech(text);
  if (!clean) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = Math.min(2, Math.max(0.5, rate || 1));
  u.lang = lang;
  const voices = speechSynthesis.getVoices() || [];
  const pick =
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang?.startsWith(lang.slice(0, 2)));
  if (pick) u.voice = pick;
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
}

export function isSpeaking() {
  return ttsSupported() && speechSynthesis.speaking;
}

function stripForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' 코드 생략 ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}
