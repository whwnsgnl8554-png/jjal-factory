// dist/ 에 앱인토스용 웹 번들을 만들어요. 원본(웹판) 파일은 건드리지 않아요.
//   - SDK 브리지(toss-bridge.js)와 광고·규격 설정(toss-config.js)을 넣고
//   - 웹 전용 부분(인앱 브라우저 전환 스크립트·배너)을 빼고
//   - 라이트 모드 고정, 핀치 줌 막기
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const WEB_FILES = ['index.html', 'style.css', 'favicon.svg', 'presets.json', 'privacy.html', 'terms.html', 'js', 'vendor'];

function mustReplace(html, from, to, label) {
  if (!(typeof from === 'string' ? html.includes(from) : from.test(html))) {
    throw new Error(`변환 지점을 못 찾았어요: ${label} — index.html 구조가 바뀌었는지 확인해 주세요`);
  }
  return html.replace(from, to);
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
console.log('▶ 토스용 웹 번들 생성');

for (const f of WEB_FILES) await cp(f, `dist/${f}`, { recursive: true });

await build({
  entryPoints: ['scripts/toss-bridge.src.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2019', 'safari14'],
  outfile: 'dist/toss-bridge.js',
  logLevel: 'warning',
});

const cfg = JSON.parse(await readFile('toss.config.json', 'utf8'));
await writeFile('dist/toss-config.js', `window.__JJAL_TOSS__ = ${JSON.stringify(cfg)};\n`);
if (!cfg.bannerAdGroupId || !cfg.interstitialAdGroupId) {
  console.log('  ⚠ toss.config.json에 광고 ID가 비어 있어요 → 광고 없이 빌드해요');
}

let html = await readFile('index.html', 'utf8');
html = mustReplace(html, /<!-- web-only:start -->[\s\S]*?<!-- web-only:end -->\s*/, '', '웹 전용 블록');
html = mustReplace(html, '<html lang="ko">', '<html lang="ko" class="toss">', 'html 태그');
html = mustReplace(html, 'initial-scale=1, viewport-fit=cover', 'initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover', 'viewport');
html = mustReplace(
  html,
  '<script type="module" src="js/app.js"></script>',
  '<script src="toss-config.js"></script>\n  <script src="toss-bridge.js"></script>\n  <script type="module" src="js/app.js"></script>',
  '앱 스크립트',
);
await writeFile('dist/index.html', html);

// 약관 페이지의 "짤공장으로" 링크: 번들 안에서는 ./ 대신 index.html
for (const f of ['privacy.html', 'terms.html']) {
  const page = await readFile(f, 'utf8');
  await writeFile(`dist/${f}`, mustReplace(page, 'href="./"', 'href="index.html"', f));
}
console.log('✔ dist/ 준비 완료');
