// Makes the synthetic media for the Google test environment: test-pattern videos and tones
// labelled 「合成測試影片／非真實錄影」, plus files for the type and size checks, and a manifest
// of their MD5 checksums for check-acceptance.mjs. Needs ffmpeg (or FFMPEG=<path>).
//   node tools/recording-pathway/test-env/make-test-media.mjs [--out <dir>] [--skip-large]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MEDIA_DIR, media } from './cases.mjs';

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const FONTS = [
  'C:/Windows/Fonts/msjh.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
];

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited with ${result.status}`);
}

// The label is burned into every frame, so a stray screenshot still shows the file is synthetic.
function labelFilter(item) {
  const font = FONTS.find(candidate => existsSync(candidate));
  if (!font) return [];
  const fontFile = font.replace(/\\/g, '/').replace(/:/g, '\\:');
  return ['-vf', `drawtext=fontfile='${fontFile}':text='iHear 合成測試影片 ${item.caseId} 非真實錄影':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-48`];
}

function make(item, out) {
  const target = path.join(out, item.name);
  const seconds = 6;
  const tone = ['-f', 'lavfi', '-i', `sine=frequency=${item.tone}:sample_rate=44100:duration=${seconds}`];
  const pattern = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=15:duration=${seconds}`];
  const clean = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];
  if (item.copyOf) return copyFileSync(path.join(out, item.copyOf), target);
  if (item.kind === 'text') return writeFileSync(target, `這是 iHear 錄影上傳驗收用的合成測試檔（${item.caseId}），用來確認表單會拒絕非影音檔案。\n`, 'utf8');
  if (item.kind === 'audio') return run([...tone, '-c:a', 'aac', '-b:a', '64k', ...clean, target]);
  if (item.kind === 'avi') return run([...pattern, ...tone, ...labelFilter(item), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest', ...clean, target]);
  if (item.kind === 'noise') {
    // Random pixels do not compress, so a few seconds of lossless video are large. A fixed
    // length (not a size cut-off) keeps the file identical every time it is regenerated.
    const noise = ['-f', 'lavfi', '-i', `nullsrc=size=640x360:rate=25:duration=${item.seconds},format=yuv420p,geq=lum='random(1)*255':cb=128:cr=128`];
    const longTone = ['-f', 'lavfi', '-i', `sine=frequency=${item.tone}:sample_rate=44100:duration=${item.seconds}`];
    run([...noise, ...longTone, ...labelFilter(item), '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-shortest', ...clean, target]);
    const size = readFileSync(target).length;
    if (size < item.bytes) throw new Error(`${item.name} 只有 ${size} bytes，小於預期的 ${item.bytes} bytes`);
    return;
  }
  return run([...pattern, ...tone, ...labelFilter(item), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', ...clean, target]);
}

function main(args) {
  const outIndex = args.indexOf('--out');
  const out = path.resolve(outIndex >= 0 ? args[outIndex + 1] : DEFAULT_MEDIA_DIR);
  const skipLarge = args.includes('--skip-large');
  const version = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    console.error('找不到 ffmpeg。請先安裝 ffmpeg，或用 FFMPEG=<ffmpeg 路徑> 指定。');
    return 1;
  }
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const item of media) {
    if (item.large && skipLarge) continue;
    make(item, out);
    const bytes = readFileSync(path.join(out, item.name));
    files.push({
      name: item.name, caseId: item.caseId, bytes: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'), sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    console.log(`${item.name.padEnd(30)} ${String(bytes.length).padStart(10)} bytes`);
  }
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), ffmpeg: version.stdout.split('\n')[0], synthetic: true, files,
  }, null, 2)}\n`);
  writeFileSync(path.join(out, 'README.txt'), '本資料夾的檔案全部由 make-test-media.mjs 產生：畫面是測試圖樣，聲音是單音，\n不含任何真實學生、真實課程或真實錄影。只用於 iHear 錄影上傳 Pathway 的 Google 測試環境驗收。\n', 'utf8');
  console.log(`\n已產生 ${files.length} 個合成測試檔：${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
