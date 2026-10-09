/**
 * 图片识别与命名工具 —— Node 版与 Worker 版共用。
 * 只依赖 Uint8Array / TextDecoder，两边运行时都原生支持。
 */

const MIME_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/svg+xml', '.svg'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['image/x-icon', '.ico'],
  ['image/heic', '.heic'],
]);

export const EXT_BY_MIME = MIME_EXT;
export const extFor = (mime) => MIME_EXT.get(mime) || '';
export const ALLOWED_MIMES = [...MIME_EXT.keys()];

const utf8 = new TextDecoder('utf-8', { fatal: false });

/**
 * 按文件头魔数识别真实图片类型；识别不出返回 null。
 * 绝不采信客户端声明的 Content-Type —— 否则任何文件都能伪装成图片混进公开域名。
 * @param {Uint8Array} buf
 * @returns {string|null} mime
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const at = (offset, len) => buf.subarray(offset, offset + len);
  const latin = (offset, len) => String.fromCharCode(...at(offset, len));
  const hex = (offset, len) => [...at(offset, len)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (hex(0, 3) === 'ffd8ff') return 'image/jpeg';
  if (hex(0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (latin(0, 4) === 'GIF8') return 'image/gif';
  if (latin(0, 4) === 'RIFF' && latin(8, 4) === 'WEBP') return 'image/webp';
  if (hex(0, 2) === '424d') return 'image/bmp';
  if (latin(4, 4) === 'ftyp') {
    const brand = latin(8, 4);
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (hex(0, 4) === '49492a00' || hex(0, 4) === '4d4d002a') return 'image/tiff';
  if (hex(0, 4) === '00000100') return 'image/x-icon';

  // SVG 是文本，只能粗略判断（先跳过 BOM 与前置空白）
  const head = utf8.decode(buf.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';

  return null;
}

/**
 * 文件名净化：只留 [a-z0-9._-]，去掉首尾的点与横线。
 * 注意不能依赖 node:path，Worker 里没有。
 */
export function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

/** 图片尺寸上限之外的基本校验：空文件、明显不是图片都在这里挡掉 */
export function looksLikeImage(buf) {
  return sniffImage(buf) !== null;
}
