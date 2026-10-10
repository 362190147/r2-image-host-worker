#!/usr/bin/env node
/**
 * 把 public/*.html 编译成 src/*-page.mjs 里的静态字符串。
 *
 * 为什么不用 Wrangler 的 Text 规则直接 `import '*.html'`：
 * 那样页面能不能加载取决于打包器是否按规则改写 import，一旦规则没生效，
 * 运行时就是「页面空白」甚至模块加载异常（Error 1101）。改成纯字符串模块后，
 * 页面模板变成普通 JS 常量，构建与运行时都不再有这层不确定性。
 *
 * 用法：node scripts/gen-page.mjs   （npm run build:page / predeploy 会自动跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把单个 HTML 源文件编译成静态字符串模块 */
async function compilePage(srcFile, outFile, exportName) {
  const html = fs.readFileSync(srcFile, 'utf8');

  // JSON.stringify 已经处理了反引号与 ${}；这里再把 </script 拆开，
  // 避免将来把这段字符串嵌进 <script> 时提前闭合（JSON 允许 \/ 转义）。
  const literal = JSON.stringify(html).replaceAll('</script', '<\\/script');

  const banner = `/**
 * 本文件由 scripts/gen-page.mjs 自动生成，请勿手改。
 * 源文件：${path.relative(ROOT, srcFile).replace(/\\/g, '/')}（改完跑 \`npm run build:page\` 重新生成）
 *
 * 生成时间无关紧要，内容只取决于源文件，因此这个文件可以安全提交到仓库。
 */`;

  const out = `${banner}
export const ${exportName} = ${literal};
export const ${exportName}Bytes = ${Buffer.byteLength(html, 'utf8')};
`;

  fs.writeFileSync(outFile, out);

  // 自检：写出去的内容必须与源文件逐字节一致
  const check = await import(`${new URL(`file://${outFile.replace(/\\/g, '/')}`).href}?t=${Date.now()}`);
  if (check[exportName] !== html) {
    console.error(`[error] 生成结果与 ${path.relative(ROOT, srcFile)} 不一致`);
    process.exit(1);
  }

  console.log(`[ok] 已生成 ${path.relative(ROOT, outFile)}（${Buffer.byteLength(html, 'utf8')} 字节，来自 ${path.relative(ROOT, srcFile)}）`);
}

// 主上传页
compilePage(
  path.join(ROOT, 'public', 'index.html'),
  path.join(ROOT, 'src', 'page.mjs'),
  'indexHtml',
);

// API 测试台
compilePage(
  path.join(ROOT, 'public', 'api-test.html'),
  path.join(ROOT, 'src', 'api-test-page.mjs'),
  'apiTestHtml',
);
