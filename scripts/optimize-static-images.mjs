import { rename } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const root = process.cwd();
const imageDirectory = path.join(root, "assets", "images");

const responsiveImages = [
  { name: "hero-classroom", quality: 80 },
  { name: "tutoring-student", quality: 80 },
  { name: "seminar", quality: 80 },
  { name: "volunteers", quality: 80 },
];

const widths = [480, 800, 1200];

for (const image of responsiveImages) {
  const source = path.join(imageDirectory, `${image.name}.jpg`);
  for (const width of widths) {
    const output = path.join(imageDirectory, `${image.name}-${width}.webp`);
    await sharp(source)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: image.quality, effort: 6, smartSubsample: true })
      .toFile(output);
  }
}

// The Open Graph artwork retains the full-resolution logo and avoids repeatedly
// recompressing the already optimized navigation asset.
const logoSource = path.join(root, "assets", "og-image.jpg");
const logo = path.join(root, "assets", "logo.png");
const optimizedLogo = path.join(root, "assets", "logo.optimized.png");
await sharp(logoSource)
  .resize({ width: 360, withoutEnlargement: true })
  .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
  .toFile(optimizedLogo);
await rename(optimizedLogo, logo);

console.log(`Optimized ${responsiveImages.length} responsive images and the shared logo.`);
