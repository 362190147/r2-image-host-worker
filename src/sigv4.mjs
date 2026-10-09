/**
 * AWS Signature V4 —— Workers 版，只用 WebCrypto，无任何依赖。
 *
 * 用于两种场景：
 *   1. 浏览器直传 R2：生成预签名 PUT URL（本文件的主体用途）；
 *   2. 可选的“Worker 代签代传”模式：直接用 fetch + 签名头请求 R2 的 S3 端点。
 *
 * 注意：R2 是路径式寻址，canonical path 必须是 /<bucket>/<key>。
 */
const encoder = new TextEncoder();

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? encoder.encode(data) : data;
  return bytesToHex(await crypto.subtle.digest('SHA-256', buf));
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? encoder.encode(data) : data));
}

/** RFC3986 编码；S3 要求路径里保留 '/'，query 里则要编码 */
function uriEncode(input, encodeSlash = true) {
  let out = '';
  for (const ch of String(input)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else out += [...encoder.encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return out;
}

function canonicalQuery(query) {
  const pairs = [];
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    pairs.push([uriEncode(k), uriEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(headers, signedList) {
  const picked = [];
  for (const name of signedList) {
    const raw = headers[name];
    if (raw === undefined) continue;
    picked.push([name, String(raw).replace(/\s+/g, ' ').trim()]);
  }
  picked.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { canonical: picked.map(([k, v]) => `${k}:${v}\n`).join(''), signed: picked.map(([k]) => k).join(';') };
}

function amzDates(at = new Date()) {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function signingKey(secret, dateStamp, region, service) {
  const kDate = await hmacSha256(encoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

export class SigV4 {
  /**
   * @param {{accessKeyId:string, secretAccessKey:string, region?:string, service?:string}} cfg
   */
  constructor(cfg) {
    this.accessKeyId = cfg.accessKeyId;
    this.secretAccessKey = cfg.secretAccessKey;
    this.region = cfg.region || 'auto';
    this.service = cfg.service || 's3';
  }

  /**
   * 生成预签名 URL（默认 GET，上传用 PUT）。
   * @param {string} url 目标完整 URL（含 bucket 路径）
   * @param {{method?:string, expiresIn?:number, at?:Date}} [opts]
   */
  async presign(url, { method = 'GET', expiresIn = 3600, at } = {}) {
    const u = new URL(url);
    const { amzDate, dateStamp } = amzDates(at);
    const scope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.min(Math.max(1, Math.floor(expiresIn)), 604800)),
      'X-Amz-SignedHeaders': 'host',
    };

    // 必须自己重编码路径：URL.pathname 不转义 '+'、'*' 等字符，
    // 而 S3 的 canonical URI 要求对这些字符做百分号编码，否则签名对不上。
    const canonicalPath = uriEncode(decodeURIComponent(u.pathname), false);

    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery(query),
      `host:${u.host}\n`,
      'host',
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const signature = bytesToHex(await hmacSha256(await signingKey(this.secretAccessKey, dateStamp, this.region, this.service), stringToSign));

    const finalQuery = canonicalQuery({ ...query, 'X-Amz-Signature': signature });
    return `${u.origin}${canonicalPath}?${finalQuery}`;
  }

  /**
   * 用签名头直接请求 R2 的 S3 端点（Worker 代传模式）。
   * @param {string} url
   * @param {{method?:string, body?:Uint8Array|ArrayBuffer|string, headers?:Record<string,string>, at?:Date}} [opts]
   */
  async fetch(url, { method = 'GET', body, headers = {}, at } = {}) {
    const u = new URL(url);
    const { amzDate, dateStamp } = amzDates(at);
    const scope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const payloadHash = body === undefined || body === null ? EMPTY_SHA256 : await sha256Hex(body);

    const all = { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, host: u.host, ...headers };
    const signable = ['host', 'x-amz-date', 'x-amz-content-sha256', 'content-type', 'cache-control'];
    const { canonical, signed } = canonicalHeaders(all, signable.filter((n) => all[n] !== undefined));

    // 同 presign：路径要自己重编码，URL.pathname 不会转义 '+' 这类字符
    const canonicalPath = uriEncode(decodeURIComponent(u.pathname), false);
    const canonicalRequest = [method, canonicalPath, canonicalQuery(Object.fromEntries(u.searchParams)), canonical, signed, payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const signature = bytesToHex(await hmacSha256(await signingKey(this.secretAccessKey, dateStamp, this.region, this.service), stringToSign));

    return fetch(u.toString(), {
      method,
      headers: {
        ...all,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
      body,
    });
  }
}

/** 供测试与调试：把编码函数露出来 */
export const __internal = { uriEncode, canonicalQuery, canonicalHeaders };
