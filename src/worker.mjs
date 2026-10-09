/**
 * Cloudflare Worker 版图床 —— 主逻辑。
 *
 * 与 Node 版的关系、以及两种上传模式的取舍，见 README.md。
 * 本文件不 import 任何 Node 专有模块，可直接被 wrangler dev / 线上 runtime 加载。
 */
import { SigV4, sha256Hex } from './sigv4.mjs';
import { sniffImage, extFor, sanitizeName } from './image-utils.mjs';
// 页面模板是构建期生成的静态字符串（scripts/gen-page.mjs），
// 没有任何条件导入或打包器规则依赖，避免“模块能构建但运行时报错”。
import { indexHtml } from './page.mjs';

const DEFAULT_MAX_MB = 20;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_EXPIRES = 604800; // 预签名 URL 最长 7 天

/* ---------------- 小工具 ---------------- */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const bad = (status, message) => json({ ok: false, error: message }, status);

/** 定长比较，避免 token 被逐字节试探 */
export function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const str = (v, fallback = '') => (typeof v === 'string' && v !== '' ? v : fallback);

export function normalizeConfig(env = {}) {
  const maxMb = Number(env.MAX_UPLOAD_MB);
  return {
    bucketName: str(env.R2_BUCKET),
    // 默认直传（浏览器 → Worker → R2）。默认值即推荐值，不靠“未配置”触发。
    uploadMode: str(env.UPLOAD_MODE, 'direct') === 'presign' ? 'presign' : 'direct',
    uploadToken: str(env.UPLOAD_TOKEN),
    deleteToken: str(env.DELETE_TOKEN),
    publicBase: str(env.R2_PUBLIC_BASE).replace(/\/+$/, ''),
    keyPrefix: str(env.KEY_PREFIX, 'img').replace(/^\/+|\/+$/g, ''),
    maxBytes: (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : DEFAULT_MAX_MB) * 1024 * 1024,
    presignExpires: Math.min(Math.max(60, Number(env.PRESIGN_EXPIRES) || 900), MAX_EXPIRES),
    accountId: str(env.R2_ACCOUNT_ID),
    accessKeyId: str(env.R2_ACCESS_KEY_ID),
    secretAccessKey: str(env.R2_SECRET_ACCESS_KEY),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN) || 0,
    corsOrigin: str(env.CORS_ORIGIN, '*'),
  };
}

/** 外链前缀：显式配置优先，否则回落到当前部署域名（配合 wrangler 的 r2_buckets[].remote 用） */
export function publicBaseFor(cfg, requestUrl) {
  if (cfg.publicBase) {
    try {
      return new URL(cfg.publicBase).origin;
    } catch {
      // 配错格式（比如漏了 https://）时不要让它把页面渲染也带崩
      console.warn(`[warn] R2_PUBLIC_BASE 不是合法 URL: ${cfg.publicBase}，本次回落到部署域名`);
    }
  }
  return new URL(requestUrl).origin;
}

/**
 * 配置体检：把"上传成功但外链打不开"这类问题在部署阶段就指出来。
 * R2 默认不公开，所以只写进桶并不等于外链可达。
 */
export function lintConfig(cfg) {
  const problems = [];
  const hints = [];
  const raw = cfg.publicBase;

  if (!raw) {
    hints.push('未设置 R2_PUBLIC_BASE：外链会回落成 <部署域名>/i/<key>，由 Worker 读 R2 回传（能用，但每张图都消耗一次 Worker 调用）。想直连 R2 就绑自定义域名或开 r2.dev。');
  } else {
    if (!/^https?:\/\//i.test(raw)) {
      problems.push(
        `R2_PUBLIC_BASE 缺少协议头（当前 "${raw}"，也不能写 "//host" 这种协议相对写法）。`
        + '必须写完整 URL，如 "https://img.example.com"。'
        + '当前已回落到部署域名，图片会走 Worker 的 /i/ 代理而不是直连 R2。',
      );
    } else {
      const parsed = new URL(raw);
      if (/\.r2\.cloudflarestorage\.com$/i.test(parsed.hostname)) {
        problems.push('R2_PUBLIC_BASE 指向的是 R2 的 S3 API 端点（.r2.cloudflarestorage.com），它需要签名，不是公开域名。请改用自定义域名或 r2.dev 域名。');
      }
      // publicBaseFor() 只取 origin，路径会被丢掉；如果用户特意写了路径，必须说清楚而不是静默忽略
      if (parsed.pathname && parsed.pathname !== '/') {
        problems.push(`R2_PUBLIC_BASE 里的路径 "${parsed.pathname}" 会被忽略（只取 origin），对象按 "<origin>/<key>" 访问。去掉路径，或改用不带路径的子域名。`);
      }
    }
  }

  if (cfg.uploadMode === 'presign') {
    const missing = ['accountId', 'accessKeyId', 'secretAccessKey'].filter((k) => !cfg[k]);
    if (missing.length) {
      problems.push(`presign 模式缺少 S3 凭据 secret：${missing.join(', ')}。`);
    }
  }

  if (!cfg.uploadToken) hints.push('未设置 UPLOAD_TOKEN：任何人都能往你的桶里传东西。');
  if (cfg.uploadToken && !cfg.deleteToken) hints.push('未设置 DELETE_TOKEN：删除接口已禁用。');
  if (!cfg.bucketName) problems.push('未设置 R2_BUCKET（仅影响展示与 presign 模式的 S3 URL 拼装）。');

  return { problems, hints };
}

function objectKey(cfg, hashHex, contentType, originalName) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = extFor(contentType) || (originalName ? `.${sanitizeName(originalName).split('.').pop()}` : '');
  return `${cfg.keyPrefix}/${yyyy}/${mm}/${hashHex.slice(0, 24)}${ext}`;
}

function filePayload(cfg, base, key, size, contentType, { deduped = false, r2Status = null } = {}) {
  const url = `${base}/${key}`;
  return {
    key,
    url,
    markdown: `![${key.split('/').pop()}](${url})`,
    html: `<img src="${url}" alt="${key.split('/').pop()}" />`,
    size,
    contentType,
    deduped,
    r2Status,
  };
}

/** 针对某个 key 的定点体检：桶里在不在 + 外链能不能打开 */
async function diagCheckKey(bucket, cfg, base, key) {
  if (!key || key.includes('..')) return { key, inBucket: null, note: 'key 不合法' };
  const object = bucket ? await bucket.head(key) : null;
  return {
    key,
    inBucket: Boolean(object),
    size: object?.size ?? null,
    contentType: object?.httpMetadata?.contentType ?? null,
    publicUrl: `${base}/${key}`,
    public: await checkPublicUrl(cfg, `${base}/${key}`),
  };
}

/** 外链可达性自检。
 *
 * "上传成功但 URL 打不开"最常见的根因是：R2 桶没开公开访问。
 * 对象明明写进桶了，但外链域名没有任何绑定能把它读出来。
 * 这里主动 HEAD 一下外链：
 *   - 200/206 → 真的能打开
 *   - 401/403 → 桶没公开（R2 默认如此），或域名没绑对
 *   - 404    → 对象不在（key 不匹配 / 写到了别的桶）
 *   - 其它   → 原样上报状态码，避免误报
 * 没配 R2_PUBLIC_BASE 时，外链就是本 Worker 自己：自请求自己的公开域名是安全的
 * （不会绕过任何鉴权，只是普通 GET/HEAD），所以同样能自检。
 */
async function checkPublicUrl(cfg, url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.status === 200 || res.status === 206) return { reachable: true, status: res.status };
    const explain = {
      401: '外链返回 401：桶没开公开访问，或自定义域名未生效（R2 默认不公开）',
      403: '外链返回 403：桶没开公开访问，或自定义域名未生效（R2 默认不公开）',
      404: '外链返回 404：对象不在该桶里 —— 检查 wrangler.toml 的 bucket_name 是否和上传写入的桶一致',
    }[res.status];
    return { reachable: false, status: res.status, note: explain || `外链返回 ${res.status}` };
  } catch (err) {
    return { reachable: false, status: null, note: `外链请求失败：${err.message}` };
  }
}

/** 受限的按 IP 限流：先用 Rate Limiting 绑定，绑定缺失或抛错才退回 isolate 内的内存计数 */
function rateLimiter(env, cfg) {
  const memory = new Map();
  let bindingBroken = false;
  return async function check(ip) {
    if (!cfg.rateLimitPerMin) return { ok: true };
    if (!bindingBroken && env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        return { ok: success };
      } catch {
        // 绑定不可用（配置错误/配额耗尽）才退化；绑定明确说“超额”时不能放行
        bindingBroken = true;
      }
    }
    const now = Date.now();
    const rec = memory.get(ip);
    if (!rec || now > rec.resetAt) {
      memory.set(ip, { count: 1, resetAt: now + 60_000 });
      return { ok: true };
    }
    rec.count += 1;
    return { ok: rec.count <= cfg.rateLimitPerMin };
  };
}

const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

/* ---------------- 上传 ---------------- */

/** 直传：请求体经由 Worker 写入 R2 绑定，R2 凭据完全不出现在浏览器端 */
async function uploadDirect(cfg, bucket, part, base) {
  const buf = await part.arrayBuffer();
  if (buf.byteLength === 0) throw Object.assign(new Error('空文件'), { status: 400 });
  if (buf.byteLength > cfg.maxBytes) {
    throw Object.assign(new Error(`文件超过 ${Math.round(cfg.maxBytes / 1024 / 1024)}MB`), { status: 413 });
  }

  const bytes = new Uint8Array(buf);
  const contentType = sniffImage(bytes);
  if (!contentType) {
    throw Object.assign(
      new Error(`不是可识别的图片格式（文件头嗅探失败，声明为 ${part.type || '未知'}）`),
      { status: 415 },
    );
  }

  const hash = await sha256Hex(bytes);
  const key = objectKey(cfg, hash, contentType, part.name);
  const body = buf; // R2 绑定接受 ArrayBuffer / ReadableStream

  let deduped = false;
  const head = await bucket.head(key);
  if (head) {
    deduped = true;
  } else {
    const put = await bucket.put(key, body, {
      httpMetadata: { contentType, cacheControl: IMMUTABLE },
    });
    if (!put) throw Object.assign(new Error('R2 写入失败'), { status: 502 });
  }

  return filePayload(cfg, base, key, buf.byteLength, contentType, { deduped, r2Status: deduped ? 200 : 200 });
}

/** 预签名：浏览器直接 PUT 到 R2，图片字节不经过 Worker（省请求与费用） */
async function uploadPresign(cfg, bucket, part, base) {
  if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw Object.assign(
      new Error('presign 模式需要 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY（S3 凭据）'),
      { status: 500 },
    );
  }

  // 读进内存只为嗅探类型与算哈希，随后即丢弃
  const buf = await part.arrayBuffer();
  if (buf.byteLength === 0) throw Object.assign(new Error('空文件'), { status: 400 });
  if (buf.byteLength > cfg.maxBytes) {
    throw Object.assign(new Error(`文件超过 ${Math.round(cfg.maxBytes / 1024 / 1024)}MB`), { status: 413 });
  }
  const bytes = new Uint8Array(buf);
  const contentType = sniffImage(bytes);
  if (!contentType) {
    throw Object.assign(new Error('不是可识别的图片格式'), { status: 415 });
  }

  const hash = await sha256Hex(bytes);
  const key = objectKey(cfg, hash, contentType, part.name);

  const existing = await bucket.head(key);
  const sigv4 = new SigV4({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const s3Url = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucketName}/${key}`;
  const uploadUrl = await sigv4.presign(s3Url, { method: 'PUT', expiresIn: cfg.presignExpires });

  const payload = filePayload(cfg, base, key, buf.byteLength, contentType, { deduped: Boolean(existing) });
  return {
    ...payload,
    // 已存在则不必再传，直接跳过直传步骤
    skipUpload: Boolean(existing),
    uploadUrl,
    // 只签了 host，因此这些头由浏览器自行发送，不影响签名有效
    uploadHeaders: { 'content-type': contentType, 'cache-control': IMMUTABLE },
    signMode: 'presign',
    note: 'R2 桶需要配置 CORS 允许来自本站的 PUT 请求，见 README 的 CORS 段',
  };
}

async function handleUpload({ request, env, cfg, bucket, base }) {
  if (cfg.uploadToken && !timingSafeEqual(request.headers.get('x-upload-token'), cfg.uploadToken)) {
    return bad(401, '上传口令错误或缺失');
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength && declaredLength > cfg.maxBytes + 2 * 1024 * 1024) {
    return bad(413, `请求体超过上限 ${Math.round(cfg.maxBytes / 1024 / 1024)}MB`);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return bad(400, '解析 multipart/form-data 失败');
  }

  const parts = [...form.entries()].filter(([name, value]) => name === 'file' && typeof value !== 'string');
  if (!parts.length) return bad(400, '未找到上传文件字段（字段名应为 file）');

  const wantRedirect = String(form.get('redirect') || '') === '1' || String(form.get('redirect') || '') === 'true';
  const wantVerify = String(form.get('verify') || '') === '1' || String(form.get('verify') || '') === 'true';
  const results = [];
  const failed = [];

  for (const [, part] of parts) {
    const name = sanitizeName(part.name) || 'upload';
    try {
      const result = cfg.uploadMode === 'presign'
        ? await uploadPresign(cfg, bucket, part, base)
        : await uploadDirect(cfg, bucket, part, base);
      results.push(result);
    } catch (err) {
      failed.push({ name, error: err.message, status: err.status || 500 });
    }
  }

  if (!results.length) {
    return bad(failed[0]?.status || 400, failed[0]?.error || '上传失败');
  }

  if (wantVerify) {
    for (const r of results) r.verify = await checkPublicUrl(cfg, r.url);
  }

  if (wantRedirect) {
    return new Response(null, { status: 302, headers: { location: results[0].url } });
  }

  const unreachable = results.filter((r) => r.verify && r.verify.reachable === false);
  return json({
    ok: true,
    mode: cfg.uploadMode,
    publicBase: base,
    files: results,
    failed,
    // 让人一眼看到"写进桶了，但外链读不出来"
    reachableCount: wantVerify ? results.filter((r) => r.verify?.reachable === true).length : undefined,
    unreachableCount: wantVerify ? unreachable.length : undefined,
    hint: unreachable.length
      ? '文件已写入 R2，但外链打不开：R2 桶默认不公开，请在桶的 Settings 里绑自定义域名或开启 r2.dev，并把域名填进 R2_PUBLIC_BASE'
      : undefined,
  });
}

/* ---------------- 删除 ---------------- */

async function handleDelete({ request, cfg, bucket }) {
  if (!cfg.deleteToken) return bad(403, '未配置 DELETE_TOKEN，删除接口已禁用');
  if (!timingSafeEqual(request.headers.get('x-delete-token'), cfg.deleteToken)) {
    return bad(401, '删除口令错误');
  }

  let key;
  try {
    ({ key } = await request.json());
  } catch {
    return bad(400, '请求体不是合法 JSON');
  }

  // 只允许删自己前缀下的对象，且拒绝任何路径穿越写法
  if (typeof key !== 'string' || !key.startsWith(`${cfg.keyPrefix}/`) || key.includes('..') || key.includes('//')) {
    return bad(400, 'key 不合法');
  }

  await bucket.delete(key);
  return json({ ok: true, key });
}

/* ---------------- 历史清单（列桶） ---------------- */

const MONTH_RE = /^\d{4}-\d{2}$/;

/** @returns {string[]} 从本月往前数 n 个月，格式 YYYY-MM */
export function recentMonths(n, at = new Date()) {
  const out = [];
  let year = at.getUTCFullYear();
  let month = at.getUTCMonth(); // 0-based，负数交给 Date.UTC 归一
  for (let i = 0; i < n; i++) {
    out.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return out;
}

function objectToEntry(cfg, base, object) {
  const key = object.key;
  const name = key.split('/').pop();
  const rawUrl = `${base}/${key}`;
  return {
    key,
    name,
    size: object.size,
    uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    contentType: object.httpMetadata?.contentType || null,
    etag: object.httpEtag || object.etag || null,
    url: rawUrl,
    // 公开域名可直接给外链；没绑域名时给走本 Worker 的 /i/ 地址，页面缩略图一定加载得出来
    thumbUrl: cfg.publicBase ? rawUrl : `${new URL(base).origin}/i/${key}`,
    markdown: `![${name}](${rawUrl})`,
    html: `<img src="${rawUrl}" alt="${name}" />`,
  };
}

/**
 * 列出桶里的图片，最新的在前。
 *
 * R2 的 list() 按 key 字典序返回且默认从最旧开始，所以这里改用
 * 「近 N 个月的前缀逐个倒序扫描」：既保证最新在前，又把 list 调用次数限制在 months 次以内
 * （R2 的 list 是 Class A 操作，会计费，不能无脑翻全桶）。
 */
async function listObjects({ bucket, cfg, base, url }) {
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 200, 1), 1000);
  const rawMonths = Number(url.searchParams.get('months'));
  const monthsCount = Math.min(Math.max(Number.isFinite(rawMonths) && rawMonths > 0 ? Math.floor(rawMonths) : 2, 1), 12);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const monthParam = url.searchParams.get('month');

  // 指定月份就只扫那一个月；否则扫近 N 个月
  let prefixes;
  if (monthParam) {
    if (!MONTH_RE.test(monthParam)) {
      return { error: 'month 参数格式应为 YYYY-MM' };
    }
    prefixes = [`${cfg.keyPrefix}/${monthParam.replace('-', '/')}/`];
  } else {
    prefixes = recentMonths(monthsCount).map((m) => `${cfg.keyPrefix}/${m.replace('-', '/')}/`);
  }

  const seen = new Set();
  const objects = [];
  const perPrefix = Math.min(1000, Math.max(limit, 100));
  let listCalls = 0;
  const truncatedPrefixes = [];

  for (const prefix of prefixes) {
    listCalls += 1;
    const res = await bucket.list({ prefix, limit: perPrefix, include: ['httpMetadata'] });
    if (res.truncated) truncatedPrefixes.push(prefix);
    for (const object of res.objects) {
      if (seen.has(object.key)) continue;
      // 双保险：有些桶里可能混着非本前缀的对象
      if (!object.key.startsWith(cfg.keyPrefix + '/')) continue;
      seen.add(object.key);
      objects.push(object);
    }
  }

  // uploaded 降序；同一时刻按 key 兜底，保证顺序稳定
  objects.sort((a, b) => {
    const ta = a.uploaded instanceof Date ? a.uploaded.getTime() : 0;
    const tb = b.uploaded instanceof Date ? b.uploaded.getTime() : 0;
    if (tb !== ta) return tb - ta;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });

  const matched = q ? objects.filter((o) => o.key.toLowerCase().includes(q)) : objects;
  const returned = matched.slice(0, limit);

  return {
    objects: returned.map((o) => objectToEntry(cfg, base, o)),
    group: monthParam || prefixes.map((p) => p.split('/')[1]).join(','),
    monthsScanned: monthParam ? 1 : monthsCount,
    listCalls,
    limit,
    returned: returned.length,
    hasMore: matched.length > returned.length,
    truncated: truncatedPrefixes.length > 0,
    truncatedPrefixes,
    note: truncatedPrefixes.length
      ? '有月份的图片数量超过单次扫描上限，只列出了该月最新的一部分：可指定 ?month=YYYY-MM 精确查看'
      : undefined,
  };
}

/* ---------------- 对外入口 ---------------- */

export function createHandler() {
  // 每个 isolate 一份计数状态，不能建在请求作用域里，否则永远只有 1 次计数
  let limiter = null;
  let limiterConfig = null;

  return async function fetch(request, env = {}, ctx = {}) {
    const cfg = normalizeConfig(env);
    const bucket = env.IMAGES;
    const url = new URL(request.url);
    const base = publicBaseFor(cfg, request.url);
    const cors = { 'access-control-allow-origin': cfg.corsOrigin };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,x-upload-token,x-delete-token',
          'access-control-max-age': '86400',
        },
      });
    }

    // 部署排错用：只回报“哪些 env 存在”，绝不回报任何值。
    // 云端的 secret/绑定名字拼错时，这是最快的定位手段。
    if (url.pathname === '/api/diag') {
      if (cfg.uploadToken && !timingSafeEqual(request.headers.get('x-upload-token'), cfg.uploadToken)) {
        return bad(401, '需要上传口令');
      }
      const has = (v) => typeof v === 'string' && v !== '';
      return json({
        ok: true,
        worker: { main: 'src/worker.mjs', pageTemplateEmbedded: indexHtml.length > 0, pageBytes: indexHtml.length },
        env: {
          IMAGES: Boolean(bucket),
          R2_BUCKET: has(env.R2_BUCKET),
          UPLOAD_MODE: has(env.UPLOAD_MODE),
          UPLOAD_TOKEN: has(env.UPLOAD_TOKEN),
          DELETE_TOKEN: has(env.DELETE_TOKEN),
          R2_PUBLIC_BASE: has(env.R2_PUBLIC_BASE),
          R2_ACCOUNT_ID: has(env.R2_ACCOUNT_ID),
          R2_ACCESS_KEY_ID: has(env.R2_ACCESS_KEY_ID),
          R2_SECRET_ACCESS_KEY: has(env.R2_SECRET_ACCESS_KEY),
        },
        resolved: { mode: cfg.uploadMode, keyPrefix: cfg.keyPrefix, maxUploadMb: Math.round(cfg.maxBytes / 1024 / 1024) },
        lint: lintConfig(cfg),
        // 带上 ?key=<上传返回的 key> 就能一次性看清两件事：
        // 对象在不在桶里、外链是不是真的能打开
        check: url.searchParams.get('key')
          ? await diagCheckKey(bucket, cfg, base, url.searchParams.get('key'))
          : undefined,
      }, 200, cors);
    }

    // 页面需要的公开配置：不含桶名等内部信息，可匿名读。
    // publicBase 统一用 base（已做合法性回落），为空表示“未配置”，由页面回落到 location.host
    if (url.pathname === '/api/config') {
      return json({
        ok: true,
        mode: cfg.uploadMode,
        publicBase: cfg.publicBase ? base : null,
        maxUploadMb: Math.round(cfg.maxBytes / 1024 / 1024),
        authRequired: Boolean(cfg.uploadToken),
      }, 200, cors);
    }

    // 诊断用的详细信息：配了口令就要求带口令，避免把桶名/模式/上限暴露给匿名扫描者
    if (url.pathname === '/api/health') {
      if (cfg.uploadToken && !timingSafeEqual(request.headers.get('x-upload-token'), cfg.uploadToken)) {
        return json({ ok: true, authRequired: true }, 200, cors);
      }
      return json({
        ok: true,
        mode: cfg.uploadMode,
        bucket: cfg.bucketName || null,
        publicBase: cfg.publicBase ? base : null,
        maxUploadMb: Math.round(cfg.maxBytes / 1024 / 1024),
        authRequired: Boolean(cfg.uploadToken),
        deleteEnabled: Boolean(cfg.deleteToken),
        keyPrefix: cfg.keyPrefix,
      }, 200, cors);
    }

    // 历史清单：受口令保护（列桶会暴露全部 key，等于桶的目录）
    if (url.pathname === '/api/list') {
      if (!bucket) return bad(500, '缺少 R2 绑定 IMAGES，请检查 wrangler.toml');
      if (!cfg.uploadToken) return bad(403, '未配置 UPLOAD_TOKEN，历史清单接口默认禁用');
      if (!timingSafeEqual(request.headers.get('x-upload-token'), cfg.uploadToken)) {
        return bad(401, '上传口令错误或缺失');
      }
      const result = await listObjects({ bucket, cfg, base, url });
      if (result.error) return bad(400, result.error);
      return json({ ok: true, publicBase: cfg.publicBase ? base : null, ...result }, 200, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/upload') {
      if (!bucket) return bad(500, '缺少 R2 绑定 IMAGES，请检查 wrangler.toml');
      // 每个配置值对应一个独立的计数窗口，配置变了就重建（也便于测试隔离）
      if (!limiter || limiterConfig !== cfg.rateLimitPerMin) {
        limiter = rateLimiter(env, cfg);
        limiterConfig = cfg.rateLimitPerMin;
      }
      const gate = await limiter(clientIp(request));
      if (!gate.ok) return bad(429, '请求过于频繁，请稍后再试');
      const res = await handleUpload({ request, env, cfg, bucket, base });
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    if (request.method === 'POST' && url.pathname === '/api/delete') {
      if (!bucket) return bad(500, '缺少 R2 绑定 IMAGES，请检查 wrangler.toml');
      const res = await handleDelete({ request, cfg, bucket });
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 线上用打包进来的静态字符串；测试可以用 env.__ASSETS__ 覆盖
      const html = (env.__ASSETS__?.indexHtml || indexHtml)
        .replaceAll('__UPLOAD_TOKEN__', cfg.uploadToken)
        .replaceAll('__MAX_MB__', String(Math.round(cfg.maxBytes / 1024 / 1024)))
        .replaceAll('__UPLOAD_MODE__', cfg.uploadMode);
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 图片兜底：仅在没配 R2_PUBLIC_BASE（未绑域名）时才会走到这里
    if (url.pathname.startsWith('/i/')) {
      if (!bucket) return bad(500, '缺少 R2 绑定 IMAGES');
      // 注意：URL 解析会先折叠 path 里的 ../，所以能走到这里的都是编码形态
      // （如 /i/img/..%2fsecret），解码后仍含 '..'，必须挡住。
      const key = decodeURIComponent(url.pathname.slice(3));
      if (!key || key.includes('..')) return bad(400, 'key 不合法');

      const range = request.headers.get('range');
      const object = await bucket.get(key, range ? { range: request.headers } : undefined);
      if (!object) return new Response('not found', { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', IMMUTABLE);
      headers.set('accept-ranges', 'bytes');
      if (object.range) {
        const offset = object.range.offset ?? 0;
        const length = object.range.length ?? object.size - offset;
        headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set('content-length', String(length));
        return new Response(object.body, { status: 206, headers });
      }
      headers.set('content-length', String(object.size));
      if (request.headers.get('if-none-match') === object.httpEtag) {
        return new Response(null, { status: 304, headers });
      }
      // HEAD 只回元数据，不带 body（上游探测、CDN 预热都会用到）
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(object.body, { headers });
    }

    return bad(404, 'not found');
  };
}

export default { fetch: createHandler() };
