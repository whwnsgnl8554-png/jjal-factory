// 프레임을 하나씩 뽑아(원본 탐색 → 합성) GIF 또는 MP4로 굽는다.
// 메모리를 아끼려고 프레임을 쌓아두지 않고 바로바로 인코더에 흘려보낸다.
import { outputSize, frameTimes, drawFrame, bitrateFor, applyQuality } from './compose.js';

export class Cancelled extends Error {}

export function mp4Supported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function repeatFor(s) {
  if (s.repeat === 'once') return -1;
  if (s.repeat === 'n') return Math.max(1, s.repeatN | 0) - 1 || -1;
  return 0; // 무한
}

/**
 * GIF 굽기. fitSize가 켜져 있으면 목표 용량을 넘을 때 FPS → 크기 → 색상 순으로 줄여 다시 굽는다.
 * onProgress({ ratio, label })
 */
export async function makeGif(src, settings, { onProgress, signal }) {
  let s = applyQuality(settings);
  const target = s.fitSize && s.targetMB ? s.targetMB * 1048576 : Infinity;
  const MAX_TRIES = 4;
  let last;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const label = attempt === 1 ? 'GIF 굽는 중' : `용량 맞추는 중 (${attempt - 1}번째 다이어트)`;
    last = await encodeGifOnce(src, s, (r) => onProgress({ ratio: r, label, attempt }), signal);
    last.settings = s;
    if (last.blob.size <= target) break;
    if (attempt === MAX_TRIES) { last.overTarget = true; break; }
    s = shrink(s, (target * 0.92) / last.blob.size, src);
    if (!s) { last.overTarget = true; break; }
  }
  return last;
}

// 용량 ∝ fps × 면적 이라고 보고 한 번에 목표 근처로 점프한다
function shrink(s, ratio, src) {
  const next = { ...s };
  let need = ratio;
  const minFps = 8;
  if (src.kind !== 'images' && next.fps > minFps) {
    const f = Math.max(minFps, Math.floor(next.fps * Math.max(need, 0.6)));
    need /= f / next.fps;
    next.fps = f;
  }
  if (need < 1) {
    const sc = Math.max(0.35 / next.scale, Math.sqrt(need));
    need /= sc * sc;
    next.scale = next.scale * sc;
  }
  if (need < 0.95 && next.colors > 64) {
    next.colors = next.colors === 256 ? 128 : 64;
  }
  if (next.fps === s.fps && next.scale === s.scale && next.colors === s.colors) return null;
  return next;
}

async function encodeGifOnce(src, s, progress, signal) {
  const { width: W, height: H } = outputSize(s, src);
  const times = frameTimes(s, src);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const worker = new Worker(new URL('./gif-worker.js', import.meta.url), { type: 'module' });
  const abort = () => worker.terminate();
  signal?.addEventListener('abort', abort);
  try {
    let inflight = 0;
    let wake = null;
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      worker.onerror = (e) => reject(new Error(e.message || 'GIF 인코더 오류'));
    });
    worker.onmessage = (e) => {
      if (e.data.type === 'ack') { inflight--; wake?.(); }
      else if (e.data.type === 'done') finish(e.data);
    };
    worker.postMessage({ type: 'start', width: W, height: H, colors: s.colors, repeat: repeatFor(s) });
    let i = 0;
    for await (const img of src.frames(times.map((f) => f.t))) {
      if (signal?.aborted) throw new Cancelled();
      drawFrame(ctx, W, H, img, s);
      const { data } = ctx.getImageData(0, 0, W, H);
      inflight++;
      worker.postMessage({ type: 'frame', buffer: data.buffer, delay: times[i].delayMs }, [data.buffer]);
      while (inflight > 3) await new Promise((r) => (wake = r));
      progress((i + 1) / times.length);
      i++;
    }
    worker.postMessage({ type: 'finish' });
    const out = await done;
    if (signal?.aborted) throw new Cancelled();
    return {
      blob: new Blob([out.bytes], { type: 'image/gif' }),
      width: W, height: H, fps: s.fps,
      duration: times.reduce((a, f) => a + f.delayMs, 0) / 1000,
    };
  } catch (e) {
    if (signal?.aborted) throw new Cancelled();
    throw e;
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}

async function pickCodec(W, H, fps, bitrate) {
  const candidates = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f'];
  for (const codec of candidates) {
    const config = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return config;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** MP4(H.264, 소리 없음) 굽기 — 쇼츠·릴스·스토리용 루프 영상 */
export async function makeMp4(src, settings, { onProgress, signal }) {
  const s = applyQuality(settings);
  if (!mp4Supported()) throw new Error('NO_WEBCODECS');
  const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer.js');
  const { width: W, height: H } = outputSize(s, src);
  const fps = s.fps;
  const times = frameTimes(s, src);
  const bitrate = Math.round(bitrateFor(W, H, fps) * s.bitrateScale);
  const config = await pickCodec(W, H, fps, bitrate);
  if (!config) throw new Error('NO_H264');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  encoder.configure(config);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const frameDur = 1e6 / fps;
  try {
    let i = 0;
    for await (const img of src.frames(times.map((f) => f.t))) {
      if (signal?.aborted) throw new Cancelled();
      if (encErr) throw encErr;
      drawFrame(ctx, W, H, img, s);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      onProgress({ ratio: (i + 1) / times.length, label: '루프 영상 굽는 중' });
      i++;
    }
    await encoder.flush();
    if (encErr) throw encErr;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  const { buffer } = muxer.target;
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    width: W, height: H, fps,
    duration: times.length / fps,
    settings: s,
  };
}
