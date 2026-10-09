/**
 * 页面模板校验：src/page.mjs 必须与 public/index.html 完全一致。
 *
 * 这个文件是构建期生成的（scripts/gen-page.mjs），如果忘了重新生成，
 * 线上页面就会和源文件不一致 —— 所以这里做一次强校验。
 *
 * 运行：node test/page.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexHtml, indexHtmlBytes } from '../src/page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const source = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

console.log('\n[1] 生成结果与源文件一致');
check('内容逐字节一致', indexHtml === source, `生成 ${indexHtml.length} 字节 / 源 ${source.length} 字节 —— 跑 npm run build:page 重新生成`);
check('字节数常量正确', indexHtmlBytes === Buffer.byteLength(source, 'utf8'), String(indexHtmlBytes));

console.log('\n[2] 模板占位符');
for (const token of ['__UPLOAD_TOKEN__', '__MAX_MB__', '__UPLOAD_MODE__']) {
  check(`含占位符 ${token}`, indexHtml.includes(token));
}
// 检查的是生成文件里的字面量，不是导出的字符串值
const generatedSource = fs.readFileSync(path.join(ROOT, 'src', 'page.mjs'), 'utf8');
check('生成文件里 </script 已被转义', !generatedSource.includes('</script') && generatedSource.includes('<\\/script'));

console.log('\n[3] 页面本身的自洽性');
check('是完整 HTML 文档', indexHtml.trimStart().startsWith('<!doctype html') && indexHtml.includes('</html>'));
check('引用了 /api/config', indexHtml.includes("fetch('/api/config')"));
check('引用了 /api/upload', indexHtml.includes("fetch('/api/upload'"));
check('引用了 /api/delete', indexHtml.includes("fetch('/api/delete'"));
check('区分 presign 与 direct 分支', indexHtml.includes("UPLOAD_MODE === 'presign'"));
check('没有残留的占位符拼写错误', !indexHtml.includes('__MAXMB__'));

console.log('\n[4] 不依赖打包器规则');
const workerSrc = fs.readFileSync(path.join(ROOT, 'src', 'worker.mjs'), 'utf8');
check('worker.mjs 从 page.mjs 取模板', workerSrc.includes("from './page.mjs'"));
check('worker.mjs 没有 html 静态导入', !/import[^\n]*\.html/.test(workerSrc));

// 回归防护：曾经用 `await import('*.html')` 加载页面，esbuild 产出的是裸 HTML 文本，
// workerd 在模块实例化阶段就会 SyntaxError，且 try/catch 包不住 —— 表现为每次请求 Error 1101。
const allSources = fs.readdirSync(path.join(ROOT, 'src'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ f, src: fs.readFileSync(path.join(ROOT, 'src', f), 'utf8') }));
const dynamicImports = allSources.filter(({ src }) => /(^|[^.\w])import\s*\(/.test(src));
check('src 下没有动态 import', dynamicImports.length === 0, dynamicImports.map((x) => x.f).join(', '));
check('src 下没有 .html 导入', !allSources.some(({ src }) => /import[^\n]*['"][^'"]*\.html['"]/.test(src)));

const assetsPath = path.join(ROOT, 'src', 'assets.mjs');
check('旧的 assets.mjs 已删除', !fs.existsSync(assetsPath));
check('page.mjs 是纯字符串模块', /export const indexHtml = "/.test(generatedSource));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
