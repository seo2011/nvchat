/* ============================================================
   vault.js — 로컬 암호화 금고
   PIN이 없으면 평문 통과(PLAIN:), PIN이 있으면 AES-GCM 암호화(ENC:)
   ============================================================ */

const PIN_KEY = 'nvchat.pin.v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

let cryptoKey = null;

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function derive(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function hasPin() {
  return !!localStorage.getItem(PIN_KEY);
}

export function isUnlocked() {
  return !hasPin() || !!cryptoKey;
}

/** PIN 설정 (이미 설정된 경우 unlock된 상태여야 함) */
export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('nvchat-ok'));
  localStorage.setItem(PIN_KEY, JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
  cryptoKey = key;
}

/** PIN 확인 → 성공 시 잠금 해제 */
export async function unlock(pin) {
  const raw = localStorage.getItem(PIN_KEY);
  if (!raw) { cryptoKey = null; return true; }
  try {
    const { salt, iv, ct } = JSON.parse(raw);
    const key = await derive(pin, unb64(salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    if (dec.decode(pt) !== 'nvchat-ok') return false;
    cryptoKey = key;
    return true;
  } catch {
    return false;
  }
}

/** 기억된 키만 지우고 PIN 기록은 남김 (다시 잠그기) */
export function lockKey() {
  cryptoKey = null;
}

/** PIN 자체를 제거 (반드시 모든 데이터를 평문으로 바꾼 뒤 호출) */
export function clearPin() {
  localStorage.removeItem(PIN_KEY);
  cryptoKey = null;
}

/** 문자열 → 저장용 형식 */
export async function seal(plain) {
  if (!hasPin()) return 'PLAIN:' + plain;
  if (!cryptoKey) throw new Error('잠금 상태에서는 저장할 수 없습니다');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plain));
  return 'ENC:' + b64(iv) + ':' + b64(ct);
}

/** 저장용 형식 → 문자열 */
export async function open(sealed) {
  if (typeof sealed !== 'string') return sealed;
  if (sealed.startsWith('PLAIN:')) return sealed.slice(6);
  if (!sealed.startsWith('ENC:')) return sealed; // 예전/평문 호환
  if (!cryptoKey) throw new Error('잠금 상태입니다');
  const parts = sealed.split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parts[1]) }, cryptoKey, unb64(parts[2]));
  return dec.decode(pt);
}
