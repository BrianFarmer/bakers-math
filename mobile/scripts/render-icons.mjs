// Draws the app icon, Android adaptive icon layers, splash mark and favicon and notification icon from one SVG design.
// Run from mobile/ after `npm i --no-save playwright && npx playwright install chromium`:
//   node scripts/render-icons.mjs
// Set PLAYWRIGHT_MODULE to the package's path to use a Playwright installed elsewhere.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const CREAM = '#FAF6F0';
const CRUMB = '#FCEBD2';

// A boule scored with a percent sign, on a 1024 canvas centered at (512, 512).
const loaf = (id, { shadow = true } = {}) => `
  <defs>
    <radialGradient id="${id}-crust" cx="0.38" cy="0.28" r="0.85">
      <stop offset="0" stop-color="#E29A52"/>
      <stop offset="0.55" stop-color="#B8651F"/>
      <stop offset="1" stop-color="#7E3C12"/>
    </radialGradient>
  </defs>
  ${shadow ? '<ellipse cx="512" cy="770" rx="360" ry="36" fill="#5A2A0B" opacity="0.18"/>' : ''}
  <path d="M150 606 C150 386 316 276 512 276 C708 276 874 386 874 606 C874 704 806 756 700 758 L324 758 C218 756 150 704 150 606 Z"
        fill="url(#${id}-crust)"/>
  <path d="M226 540 C262 420 360 340 470 318" stroke="#F4B878" stroke-width="14" stroke-linecap="round" fill="none" opacity="0.5"/>
  ${percent(CRUMB)}`;

const percent = (color) => `
  <g stroke="${color}" stroke-width="34" stroke-linecap="round" fill="none">
    <path d="M612 412 L412 664"/>
    <circle cx="436" cy="448" r="40"/>
    <circle cx="588" cy="628" r="40"/>
  </g>`;

const svg = (body, { size = 1024, bg } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  ${bg ?? ''}
  ${body}
</svg>`;

const iconBg = `
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.35" r="0.8">
      <stop offset="0" stop-color="#FFFDF9"/>
      <stop offset="1" stop-color="#F1E3CF"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>`;

// Android keeps a 66% safe zone inside the 108dp adaptive canvas, so the mark is shrunk to fit.
const inSafeZone = (body) => `<g transform="translate(512 512) scale(0.7) translate(-512 -512)">${body}</g>`;

const monochrome = `
  <mask id="cut">
    <rect width="1024" height="1024" fill="white"/>
    ${percent('black')}
  </mask>
  <path mask="url(#cut)" fill="white"
        d="M150 606 C150 386 316 276 512 276 C708 276 874 386 874 606 C874 704 806 756 700 758 L324 758 C218 756 150 704 150 606 Z"/>`;

const outputs = [
  ['assets/icon.png', 1024, svg(loaf('i'), { bg: iconBg }), false],
  ['assets/favicon.png', 48, svg(loaf('f', { shadow: false }), { size: 48, bg: iconBg }), false],
  ['assets/android-icon-foreground.png', 1024, svg(inSafeZone(loaf('a'))), true],
  ['assets/android-icon-monochrome.png', 1024, svg(inSafeZone(monochrome)), true],
  // Android's status bar icon: white on transparent, 96px for xxxhdpi.
  ['assets/notification-icon.png', 96, svg(monochrome, { size: 96 }), true],
  ['assets/splash-icon.png', 1024, svg(loaf('s', { shadow: false })), true],
];

// Google Play's feature graphic (1024 x 500): the loaf beside the app's name.
const featureGraphic = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <defs>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFDF9"/>
      <stop offset="1" stop-color="#F1E3CF"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="500" fill="url(#fg)"/>
  <g transform="translate(20 -6) scale(0.5)">${loaf('g')}</g>
  <text x="540" y="232" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="800" fill="#2B2118">Bakers Math</text>
  <text x="542" y="292" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#7A6A5C">Baker's percentages,</text>
  <text x="542" y="330" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#7A6A5C">guided bakes, a bake log.</text>
</svg>`;
outputs.push(['store/feature-graphic.png', null, featureGraphic, false]);

await mkdir('store', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, markup, transparent] of outputs) {
  await page.setViewportSize(size ? { width: size, height: size } : { width: 1024, height: 500 });
  await page.setContent(`<html><body style="margin:0;background:${transparent ? 'transparent' : CREAM}">${markup}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: transparent });
  await writeFile(file, png);
  console.log(`wrote ${file}`);
}
await browser.close();
