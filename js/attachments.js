/* ============================================================
   attachments.js — 사진/파일 첨부 처리
   이미지: 축소 후 dataURL · 텍스트/코드: 내용 추출 · PDF: 텍스트 추출
   ============================================================ */

const MAX_IMAGE_DIM = 1400;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;
export const MAX_IMAGES = 6;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql',
  'html', 'htm', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'sh', 'bat', 'ps1', 'srt', 'vtt', 'tex', 'license', 'readme',
]);

export async function processFiles(fileList) {
  const out = [];
  for (const file of Array.from(fileList || [])) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      if (file.type.startsWith('image/')) {
        out.push(await handleImage(file));
      } else if (ext === 'pdf' || file.type === 'application/pdf') {
        out.push(await handlePdf(file));
      } else if (file.type.startsWith('text/') || TEXT_EXTS.has(ext)) {
        out.push(await handleText(file));
      } else if (file.type.startsWith('audio/')) {
        out.push({ kind: 'unsupported', name: file.name, reason: '음성 파일 전사는 NVIDIA API 에서 지원되지 않아요. 마이크 버튼으로 말씀해 주세요.' });
      } else if (file.type.startsWith('video/')) {
        out.push({ kind: 'unsupported', name: file.name, reason: '영상 파일은 지원하지 않아요. 필요한 장면을 사진으로 첨부해 주세요.' });
      } else {
        out.push({ kind: 'unsupported', name: file.name, reason: '지원하지 않는 파일 형식이에요. (텍스트·코드·PDF·이미지 지원)' });
      }
    } catch (e) {
      out.push({ kind: 'unsupported', name: file.name, reason: '처리 실패: ' + (e.message || e) });
    }
  }
  return out;
}

/* ---------------- 이미지 ---------------- */

async function handleImage(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('이미지가 너무 큽니다 (12MB 초과)');
  const dataUrl = await downscale(file);
  return { kind: 'image', name: file.name || 'image', dataUrl };
}

function fit(w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

async function downscale(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await loadImageEl(file);
  }
  const { w, h } = fit(bitmap.width, bitmap.height, MAX_IMAGE_DIM);

  if (w === bitmap.width && h === bitmap.height && file.size < 400 * 1024 &&
      (file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp')) {
    if (bitmap.close) bitmap.close();
    return await fileToDataUrl(file);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const alpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
  try {
    return canvas.toDataURL(alpha ? 'image/webp' : 'image/jpeg', 0.85);
  } catch {
    return canvas.toDataURL('image/jpeg', 0.85);
  }
}

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/* ---------------- 텍스트/코드 ---------------- */

async function handleText(file) {
  let text = await file.text();
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; }
  return { kind: 'doc', name: file.name, text, truncated };
}

/* ---------------- PDF ---------------- */

async function handlePdf(file) {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const maxPages = Math.min(doc.numPages, 30);
  let text = '';
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    text += `\n[${i}페이지] ${pageText}\n`;
    if (text.length > MAX_TEXT_CHARS) break;
  }
  const body = text.replace(/\[.*?페이지\]/g, '').trim();
  if (body.length < 10) {
    return { kind: 'unsupported', name: file.name, reason: '스캔된 PDF 로 보여요. 페이지를 사진으로 찍어 첨부해 주세요.' };
  }
  return { kind: 'doc', name: file.name, text: text.trim().slice(0, MAX_TEXT_CHARS) };
}
