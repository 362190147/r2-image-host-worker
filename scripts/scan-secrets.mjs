#!/usr/bin/env node
/**
 * 分享前自查：确认项目里没有会被泄露的隐私与凭据。
 *
 * 检查三类东西：
 *   1. 危险文件（.env、.dev.vars、.wrangler/、本地图库、密钥文件）——它们必须被 .gitignore 挡住
 *   2. 密钥形态的字符串（各家 token 前缀、私钥头、AWS Access Key ID、JWT）
 *   3. 个人/账号痕迹（邮箱、本机绝对路径、16 位以上的账号 ID、内网 IP）
 *
 * 为什么会话里的 .env 明明被 gitignore 了还要查：真正的泄露几乎都来自
 * 「以为忽略了、其实没有」或「复制粘贴时带上了」。这个脚本就是用来证伪这种假设的。
 *
 * 用法：
 *   node scripts/scan-secrets.mjs                  # 扫描当前项目
 *   node scripts/scan-secrets.mjs <某个目录>       # 扫描指定目录
 *   node scripts/scan-secrets.mjs --strict         # 连提示项也当作失败（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const STRICT = process.argv.includes('--strict');

/* ---------- 扫描范围 ---------- */
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', '.tmp-test', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.cjs', '.json', '.toml', '.yml', '.yaml', '.html', '.css', '.txt', '.sh', '.ps1', '.example']);
const MAX_BYTES = 2 * 1024 * 1024;

/* ---------- 规则 ---------- */
// 危险文件：存在于仓库里就是问题（无论内容）
const DANGEROUS_FILES = [
  { re: /^\.env$/, why: '真实环境变量文件（含 R2 密钥）' },
  { re: /^\.env\.(local|production|prod)$/, why: '真实环境变量文件' },
  { re: /^\.dev\.vars(\.|$)/, why: 'wrangler 本地 secrets' },
  { re: /^\.credentials\.yaml$|^credentials\.json$/, why: '凭据文件' },
  { re: /\.(pem|key|p12|pfx|keystore|jks)$/, why: '私钥/证书' },
  { re: /^id_(rsa|ed25519|ecdsa)$/, why: 'SSH 私钥' },
  { re: /^\.npmrc$|^\.netrc$/, why: '可能含 registry/账号凭据' },
];

// 内容规则
const CONTENT_RULES = [
  // wrangler login 的 OAuth 凭据：实测存在 %APPDATA%\xdg.config\.wrangler\config\default.toml。
  // 这两个 token 的 scopes 覆盖整个账号（workers/kv/d1/pages/r2/ssl/…），泄露等于交出账号。
  { name: 'wrangler OAuth token', re: /\bcf(at|ort)_[A-Za-z0-9_-]{20,}/, severity: 'error' },
  { name: 'Cloudflare API Token（40 位）', re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]{0,40}(cloudflare|CF_|CLOUDFLARE))/i, severity: 'error' },
  { name: 'AWS Access Key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'error' },
  { name: 'OpenAI/Anthropic 风格密钥', re: /\b(sk|sk-ant)-[A-Za-z0-9_-]{20,}/, severity: 'error' },
  { name: 'GitHub token', re: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/, severity: 'error' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: 'error' },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: 'error' },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: 'error' },
  { name: '疑似明文赋值给密钥变量', re: /(secret|token|password|passwd|api_?key)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i, severity: 'warn' },
  // 用 RegExp 构造，避免正则字面量里出现引号导致的语法歧义
  { name: '本机绝对路径（含用户名）', re: new RegExp(String.raw`[A-Za-z]:\\+Users\\+[^\\\s"']+|/home/[a-z0-9_-]+|/Users/[a-z0-9_-]+`), severity: 'warn' },
  { name: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, severity: 'warn' },
  { name: '16 位以上长数字（可能是账号 ID）', re: /(?<![\w.-])\d{16,}(?![\w.-])/, severity: 'warn' },
  { name: '内网 IP', re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, severity: 'warn' },
];

// 明确放行：官方测试向量、文档域名、示例值。这些出现在公开文档里毫无风险。
const ALLOWLIST = [
  { re: /AKIDEXAMPLE/, why: 'AWS 官方 SigV4 测试套件的固定 Access Key ID' },
  { re: /wJalrXUtnFEMI\/K7MDENG\+bPxRfiCYEXAMPLEKEY/, why: 'AWS 官方 SigV4 测试套件的固定密钥，从未绑定任何真实账号' },
  { re: /(example\.com|example\.workers\.dev|r2\.cloudflarestorage\.com|r2\.dev|localhost|127\.0\.0\.1)/, why: '文档占位域名' },
  { re: /^test-(upload|delete)-token$|test-upload-token|test-delete-token/, why: '测试用假口令' },
  { re: /^images$|^img$/, why: '示例桶名/前缀' },
  // 形如 TOKEN = "__UPLOAD_TOKEN__" 的模板占位符，不是真实密钥
  { re: /["'][A-Z][A-Z0-9_]*__["']|^[A-Z_]+ = ["']__[A-Z_]+__["']$/, why: '模板占位符（__XXX__）' },
  { re: /__UPLOAD_TOKEN__|__MAX_MB__|__UPLOAD_MODE__|__ASSETS__/, why: '页面模板占位符' },
];

/* ---------- 扫描 ---------- */
const findings = [];
const skipped = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) { skipped.push(rel + '/'); continue; }
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;

    // 规则一：危险文件
    for (const rule of DANGEROUS_FILES) {
      if (rule.re.test(entry.name)) {
        findings.push({ severity: 'error', kind: '危险文件', file: rel, line: 0, sample: entry.name, why: rule.why });
      }
    }

    if (SKIP_FILES.has(entry.name)) { skipped.push(rel); continue; }
    if (!TEXT_EXT.has(path.extname(entry.name))) continue;
    const stat = fs.statSync(full);
    if (stat.size > MAX_BYTES) { skipped.push(rel + ' (过大)'); continue; }

    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const rule of CONTENT_RULES) {
        const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
        for (const match of text.matchAll(re)) {
          const hit = match[0];
          const allowed = ALLOWLIST.find((a) => a.re.test(hit) || a.re.test(text));
          if (allowed) continue;
          findings.push({
            severity: rule.severity, kind: rule.name, file: rel, line: i + 1,
            sample: hit.length > 60 ? hit.slice(0, 57) + '…' : hit,
          });
        }
      }
    });
  }
}

walk(ROOT);

/* ---------- 报告 ---------- */
// 关键：报告里绝不回显完整凭据。扫描器的输出会进终端、CI 日志、聊天记录，
// 回显等于把「发现泄露」变成「造成泄露」——所以一律只留前缀 + 长度。
function mask(text) {
  const s = String(text);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…（共 ${s.length} 字符，已脱敏）`;
}

const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`扫描目录: ${ROOT}`);
console.log(`放行: AWS 官方测试向量、example.com 等占位域名、test-* 假口令\n`);

if (errors.length) {
  console.log(`❌ 严重问题 ${errors.length} 处（必须处理后再分享）:`);
  for (const f of errors) {
    console.log(`   ${f.file}${f.line ? ':' + f.line : ''}  [${f.kind}]  ${mask(f.sample)}`);
    if (f.why) console.log(`      原因: ${f.why}`);
  }
  console.log('');
} else {
  console.log('✅ 没有发现凭据/私钥类严重问题\n');
}

if (warns.length) {
  console.log(`⚠️  需要人工确认 ${warns.length} 处（不一定是隐私，但要自己看一眼）:`);
  for (const f of warns) console.log(`   ${f.file}:${f.line}  [${f.kind}]  ${mask(f.sample)}`);
  console.log('');
} else {
  console.log('✅ 没有发现账号 ID / 邮箱 / 本机路径类痕迹\n');
}

if (skipped.length) {
  console.log(`已跳过 ${skipped.length} 项（生成物或依赖，不应分享）：`);
  for (const s of skipped.slice(0, 12)) console.log(`   ${s}`);
  if (skipped.length > 12) console.log(`   … 其余 ${skipped.length - 12} 项`);
  console.log('');
}

console.log('分享前还请确认（脚本查不出这些）:');
console.log('   • git 历史里是否提交过 .env —— 提交过就必须轮换密钥，删文件没用');
console.log('   • R2 桶里是否混进了不该公开的文件（你的图库是公开可读的）');
console.log('   • wrangler.toml 里的桶名/账号 ID 是否可接受公开');
console.log('   • 是否愿意公开源码（决定要不要加 LICENSE）');

const failed = errors.length > 0 || (STRICT && warns.length > 0);
process.exit(failed ? 1 : 0);
