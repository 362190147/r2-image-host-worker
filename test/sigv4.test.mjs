/**
 * Worker 版 SigV4（WebCrypto 实现）的校验，不需要网络也不需要 wrangler。
 *
 * 验证方式：
 *   1. 复现 AWS 官方测试套件 aws-sig-v4-test-suite 的 get-vanilla 向量；
 *   2. 与一份**内嵌的 Node 参考实现**（node:crypto 手写 HMAC）逐字节比对签名：
 *      两个运行时、两套密码学 API，结果必须完全一致；
 *   3. 预签名 URL 的结构与边界行为。
 *
 * 参考实现刻意内嵌而不 import 别的项目——本仓库要能独立克隆后立刻跑测试。
 * 它与被测实现共享的只有 sha256/hmac 原语，签名流程（规范请求拼装、作用域、密钥派生）
 * 全部独立写一遍，这才是交叉比对的意义。
 *
 * 运行：node test/sigv4.test.mjs
 */
import { createHmac, createHash } from 'node:crypto';
import { SigV4, sha256Hex, EMPTY_SHA256 } from '../src/sigv4.mjs';

const ACCESS_KEY_ID = 'AKIDEXAMPLE';
// 官方测试套件的密钥对。网上另有一个只差一个字母的写法（...+bPxRqiCYEXAMPLEKEY），
// 它复现不出套件里的期望签名，别用错。
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const DATE = '20150830T123600Z';
const DATE_STAMP = '20150830';
const AT = new Date('2015-08-30T12:36:00.000Z');
const ENDPOINT = 'https://example.amazonaws.com';
const BUCKET = 'examplebucket';

const sha256HexRef = (data) => createHash('sha256').update(data).digest('hex');
const hmacRef = (key, data) => createHmac('sha256', key).update(data).digest();

/** 独立写的 RFC3986 编码：S3 要求除 A-Za-z0-9-_.~ 外一律百分号编码 */
function rfc3986(str, encodeSlash = true) {
  return [...String(str)].map((ch) => {
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
    if (ch === '/') return encodeSlash ? '%2F' : '/';
    return [...Buffer.from(ch, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }).join('');
}

/** 内嵌的 Node 参考实现：只做预签名，够交叉比对用 */
const nodeRef = {
  presign(key, { expiresIn = 3600, method = 'GET', at, region = 'auto', service = 's3' } = {}) {
    const now = at || new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const host = new URL(ENDPOINT).host;

    const query = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${ACCESS_KEY_ID}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.min(Math.max(1, Math.floor(expiresIn)), 604800)),
      'X-Amz-SignedHeaders': 'host',
    };
    // 独立写的 query 规范化：键排序 + 值做 RFC3986 编码
    const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
    // R2 是路径式寻址，canonical path 必须含桶名，并且同样要编码
    const canonicalPath = `/${BUCKET}/${rfc3986(key, false)}`;
    const canonicalRequest = [method, canonicalPath, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexRef(canonicalRequest)].join('\n');
    const kSigning = hmacRef(hmacRef(hmacRef(hmacRef(`AWS4${SECRET_ACCESS_KEY}`, dateStamp), region), service), 'aws4_request');
    const signature = hmacRef(kSigning, sts).toString('hex');
    return `${ENDPOINT}${canonicalPath}?${qs}&X-Amz-Signature=${signature}`;
  },
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\n[1] 复现官方 get-vanilla 用例');
// get-vanilla.creq 原文
const SUITE_CANONICAL = ['GET', '/', '', 'host:example.amazonaws.com', `x-amz-date:${DATE}`, '', 'host;x-amz-date', EMPTY_SHA256].join('\n');
const suiteCrHash = await sha256Hex(SUITE_CANONICAL);
check('空负载 SHA256 常量正确', (await sha256Hex(new Uint8Array(0))) === EMPTY_SHA256);
check('规范请求哈希 = get-vanilla.sts', suiteCrHash === 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63', suiteCrHash);

const sts = ['AWS4-HMAC-SHA256', DATE, `${DATE_STAMP}/us-east-1/service/aws4_request`, suiteCrHash].join('\n');
const kSigning = hmacRef(hmacRef(hmacRef(hmacRef(`AWS4${SECRET_ACCESS_KEY}`, DATE_STAMP), 'us-east-1'), 'service'), 'aws4_request');
const suiteSig = hmacRef(kSigning, sts).toString('hex');
check('签名 = get-vanilla.authz', suiteSig === '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', suiteSig);

console.log('\n[2] WebCrypto 实现与内嵌 Node 参考实现交叉比对');
const workerSig = new SigV4({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY });
const target = `${ENDPOINT}/${BUCKET}/img/2025/06/abc.png`;
const key = 'img/2025/06/abc.png';

const workerUrl = await workerSig.presign(target, { method: 'GET', expiresIn: 600, at: AT });
const nodeUrl = nodeRef.presign(key, { expiresIn: 600, at: AT });

/**
 * 比语义而不是字节序：两个实现的 query 参数排列顺序可以不同
 * （签名参数按字母序应排在 X-Amz-SignedHeaders 之前），
 * 真正必须一致的是路径、全部参数值和签名本身。
 */
const sigOf = (url) => url.match(/X-Amz-Signature=([0-9a-f]+)/)?.[1];
const paramsOf = (url) => [...new URL(url).searchParams.entries()]
  .filter(([k]) => k !== 'X-Amz-Signature')
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

check('路径一致', new URL(workerUrl).pathname === new URL(nodeUrl).pathname);
check('查询参数（除签名外）完全一致', JSON.stringify(paramsOf(workerUrl)) === JSON.stringify(paramsOf(nodeUrl)), `\n    worker=${JSON.stringify(paramsOf(workerUrl))}\n    node  =${JSON.stringify(paramsOf(nodeUrl))}`);
check('签名逐字节一致（WebCrypto vs node:crypto）', sigOf(workerUrl) === sigOf(nodeUrl), `\n    worker=${sigOf(workerUrl)}\n    node  =${sigOf(nodeUrl)}`);
check('签名是 64 位小写十六进制', /^[0-9a-f]{64}$/.test(sigOf(workerUrl) || ''), sigOf(workerUrl));
// 签名参数按字母序排在 X-Amz-SignedHeaders 之前（'S' < 'e'，大写字母 ASCII 更小）
check('查询参数按字母序排列（canonical query 要求）', workerUrl.indexOf('X-Amz-Signature=') < workerUrl.indexOf('X-Amz-SignedHeaders='), workerUrl);

const workerPut = await workerSig.presign(target, { method: 'PUT', expiresIn: 600, at: AT });
const nodePut = nodeRef.presign(key, { method: 'PUT', expiresIn: 600, at: AT });
check('PUT 预签名同样一致', sigOf(workerPut) === sigOf(nodePut), `\n    worker=${sigOf(workerPut)}\n    node  =${sigOf(nodePut)}`);
check('PUT 与 GET 签名不同', sigOf(workerPut) !== sigOf(workerUrl));

console.log('\n[3] 预签名 URL 结构');
const u = new URL(workerUrl);
check('算法参数', u.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256');
check('凭据作用域', u.searchParams.get('X-Amz-Credential') === `${ACCESS_KEY_ID}/${DATE_STAMP}/auto/s3/aws4_request`);
check('SignedHeaders 只含 host', u.searchParams.get('X-Amz-SignedHeaders') === 'host');
check('时间戳', u.searchParams.get('X-Amz-Date') === DATE);
check('保留 key 路径', u.pathname === `/${BUCKET}/${key}`);
check('有效期上限被夹到 7 天', (await workerSig.presign(target, { expiresIn: 99999999, at: AT })).includes('X-Amz-Expires=604800'));
check('有效期下限被夹到 1 秒', (await workerSig.presign(target, { expiresIn: 0, at: AT })).includes('X-Amz-Expires=1'));

console.log('\n[4] 特殊字符编码');
const workerSpacey = await workerSig.presign(`${ENDPOINT}/${BUCKET}/img/a b+c.png`, { at: AT });
const nodeSpacey = nodeRef.presign('img/a b+c.png', { at: AT });
check('空格编码为 %20、加号编码为 %2B', workerSpacey.includes('a%20b%2Bc.png'), workerSpacey);
// 参考实现没有重编码路径，所以只比路径部分——这个差异正是当初暴露出来的 bug
check('编码后的路径与参考实现一致', workerSpacey.split('?')[0] === nodeSpacey.split('?')[0], `\n    worker=${workerSpacey.split('?')[0]}\n    node  =${nodeSpacey.split('?')[0]}`);
const chinese = await workerSig.presign(`${ENDPOINT}/${BUCKET}/img/中文.png`, { at: AT });
check('多字节字符逐字节编码', chinese.includes('%E4%B8%AD%E6%96%87.png'), chinese);

console.log('\n[5] sha256Hex 输入形态');
const bytes = new TextEncoder().encode('hello');
check('Uint8Array 与字符串结果一致', (await sha256Hex(bytes)) === (await sha256Hex('hello')));
check('ArrayBuffer 也能算', (await sha256Hex(bytes.buffer)) === (await sha256Hex('hello')));
check('空输入等于空负载常量', (await sha256Hex('')) === EMPTY_SHA256);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
