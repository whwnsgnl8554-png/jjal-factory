// 한 프레임을 출력 캔버스에 그리는 규칙(맞춤 방식·위치·자막)과
// 출력 크기·프레임 시간표 계산을 담당한다. 미리보기와 실제 변환이 같은 함수를 쓴다.

export const RATIOS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '4:3': 4 / 3 };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * 화질 모드를 실제 수치로 푼다. 'low'(저용량)는 크기 60% · fps·색상 상한 · 영상 비트레이트 절반.
 * 미리보기·예상 용량·변환이 모두 이 결과를 쓴다.
 */
export function applyQuality(s) {
  if (s.quality !== 'low') return { ...s, scale: s.scale ?? 1, bitrateScale: 1 };
  return {
    ...s,
    scale: (s.scale ?? 1) * 0.6,
    fps: Math.min(s.fps, s.format === 'gif' ? 10 : 24),
    colors: Math.min(s.colors, 128),
    bitrateScale: 0.5,
  };
}

/** 설정 + 소스 → 출력 가로·세로 (짝수, 원본보다 크게 키우지 않음) */
export function outputSize(s, src) {
  const srcRatio = src.width / src.height;
  const ratio = s.ratio === 'orig' ? srcRatio : RATIOS[s.ratio] || srcRatio;
  let w = s.width;
  let h = w / ratio;
  // GIF는 원본보다 키우면 용량만 늘고 화질은 그대로라서 원본 크기에서 멈춘다
  if (s.format === 'gif') {
    const maxW = s.fit === 'cover' ? Math.min(src.width, src.height * ratio) : src.width;
    if (w > maxW && maxW >= 120) { w = maxW; h = w / ratio; }
  }
  return { width: even(w * (s.scale || 1)), height: even(h * (s.scale || 1)) };
}

/** 원본 기준 사용 구간 */
export function clipRange(s, src) {
  if (src.kind === 'images') return { start: 0, end: src.duration, speed: 1 };
  return { start: s.start, end: s.end, speed: s.speed };
}

/** 결과물 한 바퀴 길이(초) */
export function outputDuration(s, src) {
  const { start, end, speed } = clipRange(s, src);
  const one = (end - start) / speed;
  return s.boomerang ? one * 2 : one;
}

/**
 * 결과물 프레임 시간표: [{ t: 원본 시각, delayMs }]
 * delay는 1/100초 단위 오차를 누적시키지 않도록 분배한다 (GIF는 1/100초 단위).
 */
export function frameTimes(s, src, fps = s.fps) {
  const { start, end, speed } = clipRange(s, src);
  const span = Math.max(0.05, end - start);
  const n = Math.max(1, Math.round((span / speed) * fps));
  const times = [];
  for (let i = 0; i < n; i++) times.push(start + (i / fps) * speed);
  if (s.boomerang && n > 2) {
    for (let i = n - 2; i >= 1; i--) times.push(times[i]);
  }
  let reps = 1;
  if (s.format === 'mp4' && s.repeat === 'n') reps = Math.max(1, Math.min(10, s.repeatN | 0));
  const out = [];
  for (let r = 0; r < reps; r++) {
    times.forEach((t) => {
      const i = out.length;
      const cs = Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps);
      out.push({ t, delayMs: cs * 10 });
    });
  }
  return out;
}

const blurCanvas = document.createElement('canvas');

/**
 * drawable(영상/사진)을 W×H에 그린다.
 * 반환값의 slack은 "끌어서 위치 옮기기"에 쓰는 여유 픽셀.
 */
export function drawFrame(ctx, W, H, img, s) {
  const sw = img.videoWidth || img.width;
  const sh = img.videoHeight || img.height;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const cover = Math.max(W / sw, H / sh);
  const contain = Math.min(W / sw, H / sh);
  let geo;

  if (s.fit === 'cover') {
    const dw = sw * cover, dh = sh * cover;
    const x = (W - dw) * s.focusX, y = (H - dh) * s.focusY;
    ctx.drawImage(img, x, y, dw, dh);
    geo = { slackX: dw - W, slackY: dh - H };
  } else {
    if (s.fit === 'blur') {
      // ctx.filter는 사파리에서 안 먹어서, 작게 줄였다 키우는 방식으로 흐리게 만든다
      const bw = 24, bh = Math.max(2, Math.round((24 * H) / W));
      blurCanvas.width = bw; blurCanvas.height = bh;
      const b = blurCanvas.getContext('2d');
      const bc = Math.max(bw / sw, bh / sh);
      b.drawImage(img, (bw - sw * bc) / 2, (bh - sh * bc) / 2, sw * bc, sh * bc);
      ctx.drawImage(blurCanvas, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = s.bgColor;
      ctx.fillRect(0, 0, W, H);
    }
    const dw = sw * contain, dh = sh * contain;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    geo = { slackX: 0, slackY: 0 };
  }
  ctx.restore();
  if (s.text && s.text.trim()) drawText(ctx, W, H, s);
  return geo;
}

export const TEXT_FONT = '"Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

function drawText(ctx, W, H, s) {
  const lines = s.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
  if (!lines.length) return;
  const base = Math.min(W, H);
  let size = Math.round(base * ({ s: 0.07, m: 0.1, l: 0.14 }[s.textSize] || 0.1));
  ctx.save();
  ctx.font = `800 ${size}px ${TEXT_FONT}`;
  // 가로로 넘치면 줄인다
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (widest > W * 0.9) {
    size = Math.floor((size * W * 0.9) / widest);
    ctx.font = `800 ${size}px ${TEXT_FONT}`;
  }
  const lh = size * 1.22;
  const block = lh * lines.length;
  const safeTop = s.safeArea ? H * s.safeArea.top : 0;
  const safeBottom = s.safeArea ? H * s.safeArea.bottom : 0;
  const pad = base * 0.06;
  let y0;
  if (s.textPos === 'top') y0 = safeTop + pad;
  else if (s.textPos === 'bottom') y0 = H - safeBottom - pad - block;
  else y0 = (H - block) / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  lines.forEach((line, i) => {
    const y = y0 + i * lh + (lh - size) / 2;
    if (s.textOutline) {
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = s.textColor === '#111111' ? '#ffffff' : '#111111';
      ctx.strokeText(line, W / 2, y);
    }
    ctx.fillStyle = s.textColor;
    ctx.fillText(line, W / 2, y);
  });
  ctx.restore();
}

/** 변환 전에 보여 주는 대략적인 용량 (MB) */
export function estimateMB(s, src) {
  const { width, height } = outputSize(s, src);
  const dur = outputDuration(s, src);
  if (s.format === 'mp4') {
    const bps = bitrateFor(width, height, s.fps) * (s.bitrateScale || 1);
    return (bps * dur) / 8 / 1048576;
  }
  // 사진 슬라이드는 같은 장면이 이어져서 실제 프레임 수가 사진 장수만큼만 된다
  const frames = src.kind === 'images'
    ? src.items.length * (s.boomerang ? 2 : 1)
    : Math.max(1, dur * s.fps);
  const bpp = { 32: 0.22, 64: 0.28, 128: 0.34, 256: 0.4 }[s.colors] || 0.4;
  return (width * height * frames * bpp) / 1048576;
}

export function bitrateFor(w, h, fps) {
  return Math.round(Math.min(12e6, Math.max(1.5e6, w * h * fps * 0.14)));
}
