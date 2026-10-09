/**
 * 在内存里模拟 Cloudflare R2 绑定的行为，用于在没有 wrangler/workerd 的环境下测试 Worker。
 * 只实现 worker.mjs 真正用到的那部分 API：
 *   head / get / put / delete，以及 R2ObjectBody 的 writeHttpMetadata、httpEtag、range、body。
 *
 * 这是**测试替身**，不是 R2 的完整仿真：签名校验、一致性模型、并发都不是它的职责。
 */

const encoder = new TextEncoder();

class R2ObjectBody {
  constructor(record, range) {
    this.key = record.key;
    this.size = record.bytes.length;
    this.etag = record.etag;
    this.httpEtag = `"${record.etag}"`;
    this.uploaded = new Date(record.uploaded);
    this.httpMetadata = { ...record.httpMetadata };
    this.customMetadata = { ...record.customMetadata };
    this.range = range || undefined;
    this.body = range ? record.bytes.slice(range.offset, range.offset + range.length) : record.bytes;
  }

  writeHttpMetadata(headers) {
    if (this.httpMetadata.contentType) headers.set('content-type', this.httpMetadata.contentType);
    if (this.httpMetadata.cacheControl) headers.set('cache-control', this.httpMetadata.cacheControl);
    if (this.httpMetadata.contentDisposition) headers.set('content-disposition', this.httpMetadata.contentDisposition);
    if (this.httpMetadata.contentEncoding) headers.set('content-encoding', this.httpMetadata.contentEncoding);
    if (this.httpMetadata.contentLanguage) headers.set('content-language', this.httpMetadata.contentLanguage);
  }

  async arrayBuffer() {
    return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
  }

  async text() {
    return new TextDecoder().decode(this.body);
  }
}

/** 解析 "bytes=start-end" / "bytes=start-" / "bytes=-suffix" */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  const clampedEnd = Math.min(end, size - 1);
  return { offset: start, length: clampedEnd - start + 1 };
}

async function toBytes(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return encoder.encode(body);
  if (typeof body.getReader === 'function') {
    const chunks = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
  throw new TypeError('mock R2: 不支持的 body 类型 ' + Object.prototype.toString.call(body));
}

export function createMockR2Bucket() {
  const store = new Map();
  const log = { put: [], get: [], head: [], delete: [], list: [] };
  let seed = 0;

  const bucket = {
    async head(key) {
      log.head.push(key);
      const rec = store.get(key);
      if (!rec) return null;
      return new R2ObjectBody(rec);
    },

    async get(key, options = {}) {
      log.get.push({ key, options });
      const rec = store.get(key);
      if (!rec) return null;

      let range = null;
      if (options?.range) {
        const header = options.range.get ? options.range.get('range') : options.range;
        range = parseRange(header, rec.bytes.length);
        // 按 R2 的约定：不可满足的 Range 返回对象 + range 为 undefined 由上层处理，
        // 这里简化成返回整个对象，够测 206 与 200 两条路径
      }
      return new R2ObjectBody(rec, range);
    },

    async put(key, value, options = {}) {
      const bytes = await toBytes(value);
      seed += 1;
      const record = {
        key,
        bytes,
        etag: `etag-${seed}-${bytes.length}`,
        uploaded: Date.now(),
        httpMetadata: { ...(options.httpMetadata || {}) },
        customMetadata: { ...(options.customMetadata || {}) },
      };
      store.set(key, record);
      log.put.push({ key, size: bytes.length, options });
      return new R2ObjectBody(record);
    },

    async delete(key) {
      log.delete.push(key);
      store.delete(key);
    },

    /**
     * 模拟 R2 的 list()：按 key 字典序返回、支持 prefix/cursor/limit、返回 truncated 与 cursor。
     * 真实 R2 会按内存压力少返一些，这里为了确定性只在 limit 处截断。
     */
    async list(options = {}) {
      const { prefix = '', cursor = undefined, limit = 1000 } = options;
      log.list.push({ prefix, cursor, limit, include: options.include });
      const all = [...store.values()].map((r) => r.key).filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? all.indexOf(cursor) : 0;
      const from = start === -1 ? 0 : start;
      const page = all.slice(from, from + limit);
      const truncated = from + page.length < all.length;
      // cursor 指向“下一条待返回的 key”，这样用它续传时会从该条开始
      const nextCursor = truncated ? all[from + page.length] : undefined;
      return {
        objects: page.map((k) => new R2ObjectBody(store.get(k))),
        truncated,
        cursor: nextCursor,
        delimitedPrefixes: [],
      };
    },

    /** 测试辅助 */
    __store: store,
    __log: log,
    __keys: () => [...store.keys()],
    __bytes: (key) => store.get(key)?.bytes ?? null,
  };

  return bucket;
}
