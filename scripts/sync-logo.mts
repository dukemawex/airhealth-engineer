/**
 * Regenerates logo artefacts from src/components/brand/logoGeometry.ts.
 *   npm run logo            -> writes src/app/icon.svg + docs/logo/final.svg
 *   npm run logo -- --png   -> also renders docs/logo/final-{16,32,180,512}.png (needs Playwright + Chrome)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logoSvg } from "../src/components/brand/logoGeometry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = logoSvg();
writeFileSync(join(root, "src/app/icon.svg"), svg);
writeFileSync(join(root, "docs/logo/final.svg"), svg);
console.log("wrote src/app/icon.svg and docs/logo/final.svg");

if (process.argv.includes("--png")) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage();
  for (const size of [16, 32, 180, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
    await page.screenshot({ path: join(root, `docs/logo/final-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
  console.log("rendered docs/logo/final-*.png");
}
