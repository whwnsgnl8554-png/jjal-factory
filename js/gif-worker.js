// GIF 인코딩은 무거워서 화면이 멈추지 않게 워커에서 돌린다.
// 같은 장면이 연속되면(사진 슬라이드, 멈춘 구간) 한 프레임으로 합치고 대기시간만 늘린다.
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.js';

let enc, opts, pending, count;

function sameFrame(a, b) {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer), y = new Uint32Array(b.buffer);
  for (let i = 0; i < x.length; i += 7) if (x[i] !== y[i]) return false; // 먼저 성기게
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function flush() {
  if (!pending) return;
  const { rgba, delay } = pending;
  // 팔레트는 rgb444로 뽑고(노이즈 많은 영상에서 rgb565보다 ~50배 빠름), 색 매핑은 rgb565로 곱게
  const palette = quantize(rgba, opts.colors, { format: 'rgb444' });
  const index = applyPalette(rgba, palette, 'rgb565');
  enc.writeFrame(index, opts.width, opts.height, {
    palette,
    delay,
    repeat: count === 0 ? opts.repeat : undefined,
  });
  count++;
  pending = null;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    opts = m;
    enc = GIFEncoder();
    pending = null;
    count = 0;
  } else if (m.type === 'frame') {
    const rgba = new Uint8ClampedArray(m.buffer);
    if (pending && sameFrame(pending.rgba, rgba)) {
      pending.delay += m.delay;
    } else {
      flush();
      pending = { rgba, delay: m.delay };
    }
    self.postMessage({ type: 'ack' });
  } else if (m.type === 'finish') {
    flush();
    enc.finish();
    const bytes = enc.bytes();
    self.postMessage({ type: 'done', bytes, frames: count }, [bytes.buffer]);
  }
};
