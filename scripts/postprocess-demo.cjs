const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node scripts/postprocess-demo.cjs <output-directory>');
const t = JSON.parse(fs.readFileSync(path.join(OUT, 'timeline.json'), 'utf8'));
const mainDuration = Math.max(0.1, t.mainEnd - t.mainStart);
const splitDuration = Math.max(0.1, Math.min(t.leftEnd - t.leftStart, t.rightEnd - t.rightStart, 9.0));
const totalDuration = mainDuration + splitDuration;
const filter = [
  `[0:v]trim=start=${t.mainStart}:duration=${mainDuration},setpts=PTS-STARTPTS,fps=30,scale=1440:900:flags=lanczos[main]`,
  `[1:v]trim=start=${t.leftStart}:duration=${splitDuration},setpts=PTS-STARTPTS,fps=30,scale=720:900:flags=lanczos[left]`,
  `[2:v]trim=start=${t.rightStart}:duration=${splitDuration},setpts=PTS-STARTPTS,fps=30,scale=720:900:flags=lanczos[right]`,
  `[left][right]hstack=inputs=2[split]`,
  `[main][split]concat=n=2:v=1:a=0[out]`,
].join(';');
function run(args) {
  console.log('ffmpeg', args.join(' '));
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['-y', '-i', path.join(OUT, 'raw-main.webm'), '-i', path.join(OUT, 'raw-left.webm'), '-i', path.join(OUT, 'raw-right.webm'),
  '-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'enplace-weekly-loop-first-cut.mp4')]);
run(['-y', '-i', path.join(OUT, 'enplace-weekly-loop-first-cut.mp4'), '-an', '-c:v', 'libvpx-vp9', '-b:v', '0',
  '-crf', '35', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', path.join(OUT, 'enplace-weekly-loop-readme.webm')]);
const times = [2, Math.min(17, totalDuration - 1), Math.min(34, totalDuration - 1), Math.max(1, totalDuration - 3)];
for (let i = 0; i < times.length; i++) run(['-y', '-ss', String(times[i]), '-i', path.join(OUT, 'enplace-weekly-loop-first-cut.mp4'),
  '-frames:v', '1', '-compression_level', '6', path.join(OUT, `frame-${i + 1}.png`)]);
fs.writeFileSync(path.join(OUT, 'render-metadata.json'), JSON.stringify({ mainDuration, splitDuration, totalDuration, frameTimes: times }, null, 2));
