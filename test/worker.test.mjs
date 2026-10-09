/**
 * Worker 端到端测试：直接把 Worker 的 fetch 处理器跑在 Node 里，
 * R2 绑定用 test/mock-r2.mjs 的内存实现替身。
 *
 * 这样不需要 wrangler / workerd / 网络，也不碰真实 R2，
 * 因此可以在任何环境里验证「上传 → 存储 → 去重 → 读取 → 删除」的完整行为。
 *
 * 运行：node test/worker.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import worker from '../src/worker.mjs';
import { createMockR2Bucket } from './mock-r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://img.example.workers.dev';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
));

const UPLOAD_TOKEN = 'test-upload-token';
const DELETE_TOKEN = 'test-delete-token';

// 线上由 Wrangler 打包注入页面；这里注入同一个文件，保证测的是真实模板
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeEnv(overrides = {}) {
  const bucket = createMockR2Bucket();
  const env = {
    IMAGES: bucket,
    R2_BUCKET: 'images',
    UPLOAD_MODE: 'direct',
    KEY_PREFIX: 'img',
    MAX_UPLOAD_MB: '1',
    UPLOAD_TOKEN,
    DELETE_TOKEN,
    R2_PUBLIC_BASE: 'https://img.example.com',
    // 默认关掉限流，避免用例之间互相干扰；限流自身单独测
    RATE_LIMIT_PER_MIN: '0',
    __ASSETS__: { indexHtml: INDEX_HTML },
    ...overrides,
  };
  return { env, bucket };
}

const call = (env, pathname, init = {}) =>
  worker.fetch(new Request(`${ORIGIN}${pathname}`, init), env, { waitUntil() {}, passThroughOnException() {} });

function form(files, extra = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('file', new Blob([f.data], { type: f.type || 'image/png' }), f.name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

const tokenHeader = { 'x-upload-token': UPLOAD_TOKEN };
const delHeader = { 'x-delete-token': DELETE_TOKEN, 'content-type': 'application/json' };

async function main() {
  console.log('\n[1] 页面与健康检查');
  {
    const { env } = makeEnv();
    const config = await (await call(env, '/api/config')).json();
    check('/api/config 可匿名读', config.ok === true);
    check('config 报告模式', config.mode === 'direct', config.mode);
    check('config 报告外链前缀', config.publicBase === 'https://img.example.com');
    check('config 报告上限', config.maxUploadMb === 1);
    check('config 标记需要口令', config.authRequired === true);
    check('config 不泄露桶名', config.bucket === undefined, JSON.stringify(config));

    const anonHealth = await (await call(env, '/api/health')).json();
    check('匿名 health 只回 authRequired', anonHealth.ok === true && anonHealth.authRequired === true && anonHealth.bucket === undefined, JSON.stringify(anonHealth));

    const health = await (await call(env, '/api/health', { headers: tokenHeader })).json();
    check('带口令的 health 返回详情', health.mode === 'direct' && health.bucket === 'images' && health.deleteEnabled === true);
    check('health 报告外链前缀', health.publicBase === 'https://img.example.com');
    check('health 报告 keyPrefix', health.keyPrefix === 'img');

    const res = await call(env, '/');
    const html = await res.text();
    check('页面 200 + HTML', res.status === 200 && res.headers.get('content-type').includes('text/html'));
    check('页面注入上传口令', html.includes(UPLOAD_TOKEN));
    check('页面占位符全部替换', !html.includes('__UPLOAD_TOKEN__') && !html.includes('__MAX_MB__') && !html.includes('__UPLOAD_MODE__'));
    check('页面标注直传模式', html.includes('const UPLOAD_MODE = "direct"'));

    const diag = await (await call(env, '/api/diag', { headers: tokenHeader })).json();
    check('/api/diag 报告模板已内嵌', diag.worker.pageTemplateEmbedded === true && diag.worker.pageBytes > 1000, JSON.stringify(diag.worker));
    check('/api/diag 报告绑定存在', diag.env.IMAGES === true);
    check('/api/diag 报告 env 存在性', diag.env.UPLOAD_TOKEN === true && diag.env.R2_PUBLIC_BASE === true);
    check('/api/diag 不回报任何值', !JSON.stringify(diag).includes(UPLOAD_TOKEN) && !JSON.stringify(diag).includes('img.example.com'), JSON.stringify(diag));
    check('/api/diag 需要口令', (await call(env, '/api/diag')).status === 401);

    // R2_PUBLIC_BASE 写错格式时不应把页面带崩，而是回落到部署域名
    const { env: badBase } = makeEnv({ R2_PUBLIC_BASE: 'img.example.com' });
    const badPage = await call(badBase, '/');
    check('R2_PUBLIC_BASE 非法时页面仍 200', badPage.status === 200, 'got ' + badPage.status);
    const badConfig = await (await call(badBase, '/api/config')).json();
    check('非法 base 回落到部署域名', badConfig.publicBase === ORIGIN, badConfig.publicBase);
    check('非法 base 时页面仍能打开', (await call(badBase, '/')).status === 200);
  }

  console.log('\n[2] 鉴权与限流');
  {
    const { env, bucket } = makeEnv();
    const noToken = await call(env, '/api/upload', { method: 'POST', body: form([{ name: 'a.png', data: PNG }]) });
    check('缺口令 → 401', noToken.status === 401, 'got ' + noToken.status);
    const wrong = await call(env, '/api/upload', {
      method: 'POST', headers: { 'x-upload-token': 'nope' }, body: form([{ name: 'a.png', data: PNG }]),
    });
    check('错口令 → 401', wrong.status === 401, 'got ' + wrong.status);
    check('未通过鉴权时没有写 R2', bucket.__log.put.length === 0);

    // 限流：内存降级路径（每换一个上限值就重建计数窗口，避免用例互相干扰）
    const { env: limited } = makeEnv({ RATE_LIMIT_PER_MIN: '2' });
    const send = () => call(limited, '/api/upload', { method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]) });
    const codes = [(await send()).status, (await send()).status, (await send()).status];
    check('超过每分钟上限 → 429', codes[2] === 429, JSON.stringify(codes));

    // 绑定形式的限流
    const { env: bound } = makeEnv({ RATE_LIMIT_PER_MIN: '5', RATE_LIMITER: { limit: async () => ({ success: false }) } });
    const denied = await call(bound, '/api/upload', { method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]) });
    check('Rate Limiting 绑定生效', denied.status === 429, 'got ' + denied.status);
    const { env: broken } = makeEnv({ RATE_LIMIT_PER_MIN: '9', RATE_LIMITER: { limit: async () => { throw new Error('binding down'); } } });
    const survived = await call(broken, '/api/upload', { method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]) });
    check('绑定异常时退回内存计数而不是 500', survived.status === 200, 'got ' + survived.status);
  }

  console.log('\n[3] 直传模式');
  const first = makeEnv();
  {
    const res = await call(first.env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    });
    const data = await res.json();
    check('上传 200', res.status === 200 && data.ok === true, JSON.stringify(data));
    const file = data.files[0];
    check('模式标记为 direct', data.mode === 'direct');
    check('key 形如 img/YYYY/MM/<sha256前24位>.png', /^img\/\d{4}\/\d{2}\/[0-9a-f]{24}\.png$/.test(file.key), file.key);
    check('key 用内容哈希', file.key.includes(crypto.createHash('sha256').update(PNG).digest('hex').slice(0, 24)));
    check('直链用 R2_PUBLIC_BASE', file.url === `https://img.example.com/${file.key}`, file.url);
    check('markdown 正确', file.markdown === `![${file.key.split('/').pop()}](${file.url})`);
    check('html 正确', file.html === `<img src="${file.url}" alt="${file.key.split('/').pop()}" />`);
    check('大小正确', file.size === PNG.byteLength);
    check('内容类型为嗅探结果', file.contentType === 'image/png');

    check('对象写进 R2', first.bucket.__keys().includes(file.key));
    check('R2 内容一致', Buffer.compare(Buffer.from(first.bucket.__bytes(file.key)), Buffer.from(PNG)) === 0);
    const put = first.bucket.__log.put.at(-1);
    check('httpMetadata 带 contentType', put.options.httpMetadata.contentType === 'image/png');
    check('httpMetadata 带 immutable 缓存头', put.options.httpMetadata.cacheControl.includes('immutable'), JSON.stringify(put.options.httpMetadata));
  }

  console.log('\n[4] 内容寻址去重');
  {
    const putsBefore = first.bucket.__log.put.length;
    const again = await (await call(first.env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'another-name.png', data: PNG }]),
    })).json();
    check('重复上传返回同一 key', again.files[0].key === first.bucket.__keys()[0]);
    check('标记 deduped', again.files[0].deduped === true);
    check('没有重复写 R2', first.bucket.__log.put.length === putsBefore);
  }

  console.log('\n[5] 多文件与校验');
  {
    const { env, bucket } = makeEnv();
    const multi = await (await call(env, '/api/upload', {
      method: 'POST',
      headers: tokenHeader,
      body: form([
        { name: 'a.png', data: PNG },
        { name: 'b.jpg', data: new Uint8Array(Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300', 'hex')) },
      ]),
    })).json();
    check('一次上传两个文件', multi.files.length === 2, JSON.stringify(multi.failed));
    check('第二个按内容识成 jpeg', multi.files.some((f) => f.contentType === 'image/jpeg' && f.key.endsWith('.jpg')));

    const fake = await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'evil.png', data: Buffer.from('#!/bin/sh\nrm -rf /') }]),
    });
    check('伪装成 png 的脚本 → 415', fake.status === 415, 'got ' + fake.status);
    check('被拒的文件没有落库', bucket.__keys().length === 2);

    const oversized = await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'big.png', data: Buffer.concat([Buffer.from(PNG), Buffer.alloc(2 * 1024 * 1024)]) }]),
    });
    check('超过 1MB → 413', oversized.status === 413, 'got ' + oversized.status);

    const noField = await call(env, '/api/upload', { method: 'POST', headers: tokenHeader, body: form([]) });
    check('没有文件字段 → 400', noField.status === 400, 'got ' + noField.status);

    const notForm = await call(env, '/api/upload', {
      method: 'POST', headers: { ...tokenHeader, 'content-type': 'application/json' }, body: '{"a":1}',
    });
    check('非 multipart → 400', notForm.status === 400, 'got ' + notForm.status);
  }

  console.log('\n[6] redirect=1（给 CLI 用）');
  {
    const { env } = makeEnv();
    const res = await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }], { redirect: '1' }),
    });
    check('返回 302', res.status === 302, 'got ' + res.status);
    check('Location 指向直链', /^https:\/\/img\.example\.com\/img\/\d{4}\/\d{2}\/[0-9a-f]{24}\.png$/.test(res.headers.get('location') || ''), res.headers.get('location'));
  }

  console.log('\n[7] presign 模式');
  {
    const { env, bucket } = makeEnv({
      UPLOAD_MODE: 'presign',
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    const data = await (await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    })).json();
    const file = data.files[0];
    check('模式标记为 presign', data.mode === 'presign');
    check('未使用 R2 绑定写入', bucket.__log.put.length === 0);
    check('返回预签名 PUT URL', typeof file.uploadUrl === 'string' && file.uploadUrl.startsWith('https://acct123.r2.cloudflarestorage.com/images/'));
    check('预签名 URL 带签名', /X-Amz-Signature=[0-9a-f]{64}/.test(file.uploadUrl), file.uploadUrl);
    check('预签名 URL 的路径含桶名与 key', new URL(file.uploadUrl).pathname === `/images/${file.key}`);
    check('给出了浏览器要带的头', file.uploadHeaders['content-type'] === 'image/png' && file.uploadHeaders['cache-control'].includes('immutable'));
    check('给出了 CORS 提示', String(file.note).includes('CORS'));

    const expires = Number(new URL(file.uploadUrl).searchParams.get('X-Amz-Expires'));
    check('有效期来自 PRESIGN_EXPIRES 默认值', expires === 900, String(expires));

    // 预签名模式下 Worker 看不到对象（PUT 直接打到 R2），
    // 这里手动把对象放进替身里，模拟“浏览器已经传过一次”
    const parsed = new URL(file.uploadUrl);
    const s3Key = parsed.pathname.split('/').slice(2).join('/');
    await bucket.put(s3Key, PNG, { httpMetadata: { contentType: 'image/png' } });
    const second = await (await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'x.png', data: PNG }]),
    })).json();
    check('对象已存在时 skipUpload', second.files[0].skipUpload === true, JSON.stringify(second.files[0]));
    check('已存在时标记 deduped', second.files[0].deduped === true);

    // 缺 S3 凭据 → 明确报错，而不是静默降级
    const { env: noCreds } = makeEnv({ UPLOAD_MODE: 'presign' });
    const err = await call(noCreds, '/api/upload', { method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]) });
    check('presign 模式缺凭据 → 500 且有说明', err.status === 500, 'got ' + err.status);
  }

  console.log('\n[8] /i/ 兜底读取');
  {
    const { env, bucket } = makeEnv({ R2_PUBLIC_BASE: '' });
    const health = await (await call(env, '/api/health', { headers: tokenHeader })).json();
    check('未配 R2_PUBLIC_BASE 时 health 返回 null', health.publicBase === null, JSON.stringify(health.publicBase));

    const up = await (await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    })).json();
    // 用 URL 规范化后再比：CDN 对 /i/img/... 会归一成 /img/...
    const gotPath = new URL(up.files[0].url).pathname.replace(/^\/i\//, '/');
    check('未配域名时直链回落到部署域名', new URL(up.files[0].url).origin === ORIGIN && gotPath === `/${up.files[0].key}`, up.files[0].url);

    const res = await call(env, `/i/${up.files[0].key}`);
    const got = new Uint8Array(await res.arrayBuffer());
    check('GET /i/<key> 200', res.status === 200);
    check('回传 content-type', res.headers.get('content-type') === 'image/png');
    check('回传 immutable 缓存头', res.headers.get('cache-control').includes('immutable'));
    check('内容一致', Buffer.compare(Buffer.from(got), Buffer.from(PNG)) === 0);
    check('带 etag', Boolean(res.headers.get('etag')));
    check('声明支持 Range', res.headers.get('accept-ranges') === 'bytes');

    const etag = res.headers.get('etag');
    const cached = await call(env, `/i/${up.files[0].key}`, { headers: { 'if-none-match': etag } });
    check('If-None-Match 命中 → 304', cached.status === 304, 'got ' + cached.status);

    const headRes = await call(env, `/i/${up.files[0].key}`, { method: 'HEAD' });
    check('HEAD /i/<key> → 200', headRes.status === 200, 'got ' + headRes.status);
    check('HEAD 回元数据且无 body', headRes.headers.get('content-type') === 'image/png'
      && headRes.headers.get('content-length') === String(PNG.byteLength)
      && (await headRes.arrayBuffer()).byteLength === 0);

    const ranged = await call(env, `/i/${up.files[0].key}`, { headers: { range: 'bytes=0-7' } });
    check('Range 请求 → 206', ranged.status === 206, 'got ' + ranged.status);
    check('Content-Range 正确', ranged.headers.get('content-range') === `bytes 0-7/${PNG.byteLength}`, ranged.headers.get('content-range'));
    const part = new Uint8Array(await ranged.arrayBuffer());
    check('只返回请求的 8 字节', part.byteLength === 8 && Buffer.compare(Buffer.from(part), Buffer.from(PNG.slice(0, 8))) === 0);

    check('不存在的 key → 404', (await call(env, '/i/img/1999/01/does-not-exist.png')).status === 404);
    // 未编码的 ../ 会被 URL 解析先折叠掉，能打到防护逻辑的是编码形态
    check('编码形态的目录穿越 → 400', (await call(env, '/i/img/..%2fsecret')).status === 400);
    check('折叠后的越界路径 → 404（不会读到别的对象）', (await call(env, '/i/img/../../secret')).status === 404);
    check('R2 绑定缺失时明确报错', (await call({}, '/i/x.png')).status === 500);
  }

  console.log('\n[9] 删除');
  {
    const { env, bucket } = makeEnv();
    const key = (await (await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    })).json()).files[0].key;

    check('无删除口令 → 401', (await call(env, '/api/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).status === 401);
    check('错删除口令 → 401', (await call(env, '/api/delete', { method: 'POST', headers: { ...delHeader, 'x-delete-token': 'x' }, body: JSON.stringify({ key }) })).status === 401);
    check('越界 key → 400', (await call(env, '/api/delete', { method: 'POST', headers: delHeader, body: JSON.stringify({ key: 'other/1.png' }) })).status === 400);
    check('含 .. 的 key → 400', (await call(env, '/api/delete', { method: 'POST', headers: delHeader, body: JSON.stringify({ key: 'img/../../x.png' }) })).status === 400);
    check('含 // 的 key → 400', (await call(env, '/api/delete', { method: 'POST', headers: delHeader, body: JSON.stringify({ key: 'img//x.png' }) })).status === 400);
    check('非 JSON 体 → 400', (await call(env, '/api/delete', { method: 'POST', headers: delHeader, body: 'not json' })).status === 400);

    const ok = await call(env, '/api/delete', { method: 'POST', headers: delHeader, body: JSON.stringify({ key }) });
    check('删除 200', ok.status === 200, 'got ' + ok.status);
    check('R2 对象已删除', !bucket.__keys().includes(key));
    check('删除后 /i/ 404', (await call(env, `/i/${key}`)).status === 404);

    const { env: noDelete } = makeEnv({ DELETE_TOKEN: '' });
    check('未配置 DELETE_TOKEN → 403', (await call(noDelete, '/api/delete', { method: 'POST', headers: delHeader, body: JSON.stringify({ key }) })).status === 403);
  }

  console.log('\n[10] 路由与 CORS');
  {
    const { env } = makeEnv();
    check('未知路径 → 404', (await call(env, '/nope')).status === 404);
    check('GET /api/upload → 404', (await call(env, '/api/upload')).status === 404);

    const preflight = await call(env, '/api/upload', { method: 'OPTIONS' });
    check('OPTIONS → 204', preflight.status === 204);
    check('预检允许所需头', (preflight.headers.get('access-control-allow-headers') || '').includes('x-upload-token'));
    check('预检允许 POST', (preflight.headers.get('access-control-allow-methods') || '').includes('POST'));

    const health = await call(env, '/api/config');
    check('API 响应带 CORS 头', Boolean(health.headers.get('access-control-allow-origin')));
  }

  console.log('\n[11] 外链可达性自检（对应“上传成功但 URL 打不开”）');
  {
    const realFetch = globalThis.fetch;
    const stub = (status) => {
      const calls = [];
      globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status });
      };
      return calls;
    };

    // 桶没公开：R2 对未公开对象返回 401/403
    const { env } = makeEnv();
    let calls = stub(403);
    const denied = await (await call(env, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }], { verify: '1' }),
    })).json();
    globalThis.fetch = realFetch;
    check('verify=1 时上报外链不可达', denied.unreachableCount === 1 && denied.files[0].verify.reachable === false, JSON.stringify(denied.files[0].verify));
    check('不可达时给出 403 解释', String(denied.files[0].verify.note).includes('没开公开访问'), denied.files[0].verify.note);
    check('不可达时给出可操作提示', String(denied.hint).includes('R2_PUBLIC_BASE'));
    check('自检只发 HEAD', calls.every((c) => c.method === 'HEAD'), JSON.stringify(calls));
    check('自检请求的是外链 URL', calls[0]?.url === denied.files[0].url, JSON.stringify(calls));

    // 桶已公开
    const { env: okEnv } = makeEnv();
    stub(200);
    const ok = await (await call(okEnv, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }], { verify: '1' }),
    })).json();
    globalThis.fetch = realFetch;
    check('公开时上报可达', ok.reachableCount === 1 && ok.files[0].verify.reachable === true);
    check('可达时不给 hint', ok.hint === undefined);

    // 未配置 R2_PUBLIC_BASE：外链走 Worker 自己，同样能自检（自请求自己的公开域名）
    const { env: localEnv } = makeEnv({ R2_PUBLIC_BASE: '' });
    let localCalls = stub(200);
    const localUp = await (await call(localEnv, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }], { verify: '1' }),
    })).json();
    globalThis.fetch = realFetch;
    check('未配域名时也做自检', localUp.files[0].verify.reachable === true, JSON.stringify(localUp.files[0].verify));
    check('未配域名时自检的是本 Worker 的 /i/ 地址', localCalls[0]?.url === localUp.files[0].url, JSON.stringify(localCalls));

    // 不带 verify 时不做自检，避免每次上传都多一次外部请求
    const { env: plainEnv } = makeEnv();
    let plainCalls = stub(200);
    const plain = await (await call(plainEnv, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    })).json();
    globalThis.fetch = realFetch;
    check('默认不上报 verify 结果', plain.files[0].verify === undefined);
    check('默认不自检（零外部请求）', plainCalls.length === 0, JSON.stringify(plainCalls));

    console.log('\n[12] /api/diag?key= 定点体检与配置检查');
    const { env: diagEnv, bucket } = makeEnv();
    const uploaded = await (await call(diagEnv, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'shot.png', data: PNG }]),
    })).json();
    const key = uploaded.files[0].key;

    stub(403);
    const diag1 = await (await call(diagEnv, `/api/diag?key=${encodeURIComponent(key)}`, { headers: tokenHeader })).json();
    globalThis.fetch = realFetch;
    check('diag 确认对象在桶里', diag1.check.inBucket === true, JSON.stringify(diag1.check));
    check('diag 回报对象大小与类型', diag1.check.size === PNG.byteLength && diag1.check.contentType === 'image/png');
    check('diag 指出外链 403', diag1.check.public.reachable === false && diag1.check.public.status === 403);
    check('diag 回报 publicUrl', diag1.check.publicUrl === uploaded.files[0].url);

    stub(404);
    const diag2 = await (await call(diagEnv, '/api/diag?key=img/1999/01/missing.png', { headers: tokenHeader })).json();
    globalThis.fetch = realFetch;
    check('不存在的 key 报 inBucket=false', diag2.check.inBucket === false);
    check('404 时提示检查桶名', String(diag2.check.public.note).includes('bucket_name'), diag2.check.public.note);

    const diag3 = await (await call(diagEnv, '/api/diag?key=img/..%2fsecret', { headers: tokenHeader })).json();
    check('非法 key 被拒于体检之外', diag3.check.inBucket === null && diag3.check.note === 'key 不合法', JSON.stringify(diag3.check));

    const { env: lintNone } = makeEnv({ R2_PUBLIC_BASE: '' });
    const lintBad = await (await call(lintNone, '/api/diag', { headers: tokenHeader })).json();
    check('无 R2_PUBLIC_BASE 时 lint 给提示', lintBad.lint.hints.some((h) => h.includes('R2_PUBLIC_BASE')), JSON.stringify(lintBad.lint));

    // 只写域名（漏协议头）是最常见的写法错误，必须被明确指出来
    for (const badBase of ['img.example.com', '//img.example.com', 'img.example.com/i']) {
      const { env: badEnv } = makeEnv({ R2_PUBLIC_BASE: badBase });
      const bad = await (await call(badEnv, '/api/diag', { headers: tokenHeader })).json();
      check(`漏协议头被 lint 指出：${badBase}`, bad.lint.problems.some((p) => p.includes('协议头')), JSON.stringify(bad.lint.problems));
      const up = await (await call(badEnv, '/api/upload', {
        method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]),
      })).json();
      check(`漏协议头时回落到部署域名：${badBase}`, up.files[0].url.startsWith(`${ORIGIN}/`), up.files[0].url);
    }

    // 末尾斜杠无所谓
    const { env: slashEnv } = makeEnv({ R2_PUBLIC_BASE: 'https://img.example.com/' });
    const slashed = await (await call(slashEnv, '/api/upload', {
      method: 'POST', headers: tokenHeader, body: form([{ name: 'a.png', data: PNG }]),
    })).json();
    check('末尾斜杠被规范化', slashed.files[0].url.startsWith('https://img.example.com/img/'), slashed.files[0].url);
    check('末尾斜杠不产生双斜杠', !slashed.files[0].url.includes('.com//'), slashed.files[0].url);

    const { env: lintUrl } = makeEnv({ R2_PUBLIC_BASE: 'img.example.com' });
    const lintBad2 = await (await call(lintUrl, '/api/diag', { headers: tokenHeader })).json();
    check('缺协议头被 lint 指为问题', lintBad2.lint.problems.some((p) => p.includes('协议头')), JSON.stringify(lintBad2.lint.problems));

    const { env: lintEndpoint } = makeEnv({ R2_PUBLIC_BASE: 'https://acct123.r2.cloudflarestorage.com' });
    const lintBad3 = await (await call(lintEndpoint, '/api/diag', { headers: tokenHeader })).json();
    check('指向 S3 端点被 lint 指出', lintBad3.lint.problems.some((p) => p.includes('S3 API 端点')), JSON.stringify(lintBad3.lint.problems));

    const { env: lintPath } = makeEnv({ R2_PUBLIC_BASE: 'https://img.example.com/i' });
    const lintBad4 = await (await call(lintPath, '/api/diag', { headers: tokenHeader })).json();
    check('带路径被 lint 指出会被忽略', lintBad4.lint.problems.some((p) => p.includes('会被忽略')), JSON.stringify(lintBad4.lint.problems));
    // 只取 origin：对象按 <origin>/<key> 访问，所以 /i 前缀确实丢了
    const pathConfig = await (await call(lintPath, '/api/config')).json();
    check('带路径时 publicBase 只保留 origin', pathConfig.publicBase === 'https://img.example.com', pathConfig.publicBase);

    check('diag 不泄露 secret 值', !JSON.stringify(diag1).includes(UPLOAD_TOKEN), '不应包含 token 明文');
  }

  console.log('\n[13] 历史清单 /api/list（服务端列桶）');
  {
    const { env, bucket } = makeEnv();

    check('未配置口令时禁用', (await call(makeEnv({ UPLOAD_TOKEN: '' }).env, '/api/list')).status === 403);
    check('缺口令 → 401', (await call(env, '/api/list')).status === 401);
    check('错口令 → 401', (await call(env, '/api/list', { headers: { 'x-upload-token': 'nope' } })).status === 401);

    const empty = await (await call(env, '/api/list', { headers: tokenHeader })).json();
    check('空桶返回空数组', Array.isArray(empty.objects) && empty.objects.length === 0);
    check('空桶仍回报扫描信息', empty.monthsScanned === 2 && empty.listCalls === 2, JSON.stringify({ m: empty.monthsScanned, c: empty.listCalls }));

    // 造 12 张：Key 里带可控的“月份”目录，直接写进替身以模拟历史数据
    const now = new Date();
    const ym = (offset) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 15));
      return { dir: `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`, ts: d.getTime() + 86_400_000 };
    };
    const made = [];
    for (let i = 0; i < 12; i++) {
      const { dir, ts } = ym(Math.floor(i / 4)); // 3 个月，每月 4 张
      const key = `img/${dir}/hash${String(i).padStart(2, '0')}${'a'.repeat(18)}.png`;
      await bucket.put(key, PNG, { httpMetadata: { contentType: 'image/png', cacheControl: 'public' } });
      bucket.__store.get(key).uploaded = ts + i * 1000; // 同月内制造不同上传时间
      made.push({ key, ts: ts + i * 1000 });
    }

    const list = await (await call(env, '/api/list', { headers: tokenHeader })).json();
    check('列出近 2 个月的对象', list.objects.length === 8, 'got ' + list.objects.length);
    check('每月一次 list 调用', list.listCalls === 2 && list.monthsScanned === 2);
    const times = list.objects.map((o) => new Date(o.uploaded).getTime());
    check('按上传时间倒序（最新在前）', times.every((t, i) => i === 0 || times[i - 1] >= t), JSON.stringify(times));
    check('不带本前缀的对象被过滤', list.objects.every((o) => o.key.startsWith('img/')));

    const first = list.objects[0];
    check('条目含 key/name/size/contentType/etag', Boolean(first.key && first.name && first.size === PNG.byteLength && first.contentType === 'image/png' && first.etag));
    check('条目含直链与 markdown', first.url === `https://img.example.com/${first.key}` && first.markdown.includes(first.url));
    check('配了公开域名时 thumbUrl 用直链', first.thumbUrl === first.url);

    const more = await (await call(env, '/api/list?months=3', { headers: tokenHeader })).json();
    check('months=3 扫到 12 张', more.objects.length === 12, 'got ' + more.objects.length);
    check('months=3 调用 3 次 list', more.listCalls === 3);

    const limited = await (await call(env, '/api/list?months=3&limit=5', { headers: tokenHeader })).json();
    check('limit 生效', limited.objects.length === 5 && limited.hasMore === true, JSON.stringify({ n: limited.objects.length, more: limited.hasMore }));

    const searched = await (await call(env, '/api/list?months=3&q=hash03', { headers: tokenHeader })).json();
    check('q 按 key 过滤', searched.objects.length === 1 && searched.objects[0].key.includes('hash03'), JSON.stringify(searched.objects.map((o) => o.key)));

    const month = ym(1).dir.replace('/', '-');
    const oneMonth = await (await call(env, `/api/list?month=${month}`, { headers: tokenHeader })).json();
    check('指定 month 只扫该月', oneMonth.listCalls === 1 && oneMonth.objects.length === 4, JSON.stringify({ c: oneMonth.listCalls, n: oneMonth.objects.length }));
    check('month 非法 → 400', (await call(env, '/api/list?month=2026-1', { headers: tokenHeader })).status === 400);

    // 未绑域名时缩略图走 Worker 的 /i/，保证一定加载得出来
    const { env: localEnv, bucket: localBucket } = makeEnv({ R2_PUBLIC_BASE: '' });
    await localBucket.put('img/2026/10/abc.png', PNG, { httpMetadata: { contentType: 'image/png' } });
    const localList = await (await call(localEnv, '/api/list', { headers: tokenHeader })).json();
    const localEntry = localList.objects[0];
    check('未绑域名时 url 走部署域名', localEntry.url === `${ORIGIN}/img/2026/10/abc.png`, localEntry.url);
    check('未绑域名时 thumbUrl 走 /i/ 代理', localEntry.thumbUrl === `${ORIGIN}/i/${localEntry.key}`, localEntry.thumbUrl);

    // 单月对象数超过扫描上限要显式告警，而不是悄悄少给
    const { env: manyEnv, bucket: manyBucket } = makeEnv();
    const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    for (let i = 0; i < 150; i++) {
      await manyBucket.put(`img/${dir}/x${String(i).padStart(3, '0')}${'b'.repeat(16)}.png`, PNG, { httpMetadata: { contentType: 'image/png' } });
    }
    const many = await (await call(manyEnv, '/api/list?limit=10', { headers: tokenHeader })).json();
    check('超过单月扫描上限时给出告警', many.truncated === true && String(many.note).includes('month='), JSON.stringify({ t: many.truncated, note: many.note }));

    // 清单里的条目要能直接删掉
    const del = await call(env, '/api/delete', {
      method: 'POST', headers: delHeader, body: JSON.stringify({ key: first.key }),
    });
    check('清单条目可直接删除', del.status === 200);
    const after = await (await call(env, '/api/list', { headers: tokenHeader })).json();
    check('删除后不再出现在清单里', !after.objects.some((o) => o.key === first.key));
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
