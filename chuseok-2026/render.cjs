// Renders index.html to JPEG (and PNG with --png) using headless Chromium.
// Usage: node render.cjs [--png] [--out=dir] [name:query ...]
//   node render.cjs                                  -> output/chuseok-2026-poster.jpg, output/chuseok-2026-art.jpg
//   node render.cjs --out=/tmp/x preview:size=960    -> quick preview
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}

(async () => {
  const { chromium } = loadPlaywright();
  const args = process.argv.slice(2);
  const png = args.includes('--png');
  const outArg = args.find((a) => a.startsWith('--out='));
  const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(__dirname, 'output'));
  const named = args.filter((a) => !a.startsWith('--'));
  const variants = named.length
    ? named.map((a) => { const [name, query = ''] = a.split(':'); return { name, query }; })
    : [{ name: 'chuseok-2026-poster', query: 'mode=poster' }, { name: 'chuseok-2026-art', query: 'mode=art' }];
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const url = pathToFileURL(path.join(__dirname, 'index.html')).href;
  for (const v of variants) {
    const t0 = Date.now();
    await page.goto(`${url}?${v.query}`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 180000 });
    const formats = [['jpg', 'image/jpeg', 0.94], ...(png ? [['png', 'image/png']] : [])];
    for (const [ext, type, q] of formats) {
      const data = await page.evaluate(([t, quality]) => document.getElementById('art').toDataURL(t, quality), [type, q]);
      const file = path.join(outDir, `${v.name}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      console.log(`${file}  ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
    }
    console.log(`  ${v.name}: ${Date.now() - t0} ms`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
