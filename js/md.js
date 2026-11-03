/* ============================================================
   md.js — 마크다운 렌더링 (marked + DOMPurify, CDN 동적 로드)
   CDN 실패 시 안전한 평문 폴백으로 동작
   ============================================================ */

let marked = null;
let purify = null;
let ready = false;

export async function initMd() {
  try {
    const [m, p] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js'),
      import('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs'),
    ]);
    marked = m.marked || m.default;
    purify = p.default;
    marked.setOptions({ gfm: true, breaks: true });
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    ready = true;
  } catch (e) {
    console.warn('마크다운 라이브러리를 불러오지 못했습니다(평문 표시).', e);
  }
  return ready;
}

export function isMdReady() {
  return ready;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 텍스트 → 안전한 HTML 문자열 */
export function renderMd(text) {
  const src = String(text ?? '');
  if (!ready) {
    return '<p>' + escapeHtml(src).replace(/\n/g, '<br>') + '</p>';
  }
  try {
    const html = marked.parse(src);
    return purify.sanitize(html, { ADD_ATTR: ['target'] });
  } catch {
    return '<p>' + escapeHtml(src).replace(/\n/g, '<br>') + '</p>';
  }
}

/** 스트리밍 중 가벼운 표시용 (마크다운 없이 줄바꿈만) */
export function renderPlain(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/** 코드 블록에 복사 버튼 추가 */
export function enhanceCodeBlocks(root) {
  root.querySelectorAll('pre:not([data-enhanced])').forEach((pre) => {
    pre.setAttribute('data-enhanced', '1');
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'icon-btn code-copy';
    btn.title = '코드 복사';
    btn.innerHTML = '<svg class="ic"><use href="#i-copy"/></svg>';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.innerText ?? pre.innerText;
      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
        setTimeout(() => { btn.innerHTML = '<svg class="ic"><use href="#i-copy"/></svg>'; }, 900);
      } catch { /* 무시 */ }
    });
    wrap.appendChild(btn);
  });
}
