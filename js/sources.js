// 입력 파일(영상 / 사진 여러 장 / GIF)을 "시간 t에 그릴 수 있는 것"으로 통일한다.
// 모든 소스는 { kind, width, height, duration, frameAt(t) → drawable, thumb, dispose() } 형태.

const MAX_VIDEO_MB = 2048;   // 이보다 크면 폰 브라우저가 못 연다
const HEAVY_VIDEO_MB = 100;  // 이보다 크거나 길거나 고해상도면 저용량 모드를 권한다

export class SourceError extends Error {}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}
function isGif(file) {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name);
}
function isVideo(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
}

export async function loadSource(files) {
  const list = [...files];
  if (!list.length) throw new SourceError('파일이 선택되지 않았어요.');
  const video = list.find(isVideo);
  if (video) return loadVideo(video);
  if (list.length === 1 && isGif(list[0])) return loadGif(list[0]);
  return loadImages(list.filter((f) => !isVideo(f)));
}

/* ---------- 영상 ---------- */
async function loadVideo(file) {
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
    throw new SourceError(`영상이 ${(file.size / 1073741824).toFixed(1)}GB예요. 2GB가 넘는 영상은 브라우저가 열지 못해요. 필요한 부분만 잘라서 다시 올려 주세요.`);
  }
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  // 화면에 붙어 있어야 requestVideoFrameCallback이 제때 불린다 (눈에 안 보이게)
  v.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  v.src = url;
  v.load();
  const fail = new SourceError('이 영상은 브라우저가 열지 못해요. 사진 앱에서 ‘동영상 저장’으로 다시 저장하거나, 다른 영상으로 해 볼까요?');
  try {
    // 아이폰(사파리·카톡 등 인앱 브라우저)은 preload를 무시해서 loadeddata가 안 올 수 있다.
    // 메타데이터만 기다린 뒤, 음소거 재생을 잠깐 시켜 첫 프레임을 받아 둔다.
    await withTimeout(new Promise((resolve, reject) => {
      if (v.readyState >= 1) resolve();
      v.addEventListener('loadedmetadata', resolve, { once: true });
      v.addEventListener('error', reject, { once: true });
    }), 20000);
    if (v.readyState < 2) {
      const ready = waitEvent(v, ['loadeddata', 'canplay'], 8000);
      try { await v.play(); } catch { /* 재생이 막혀도 탐색으로 프레임을 받는다 */ }
      v.pause();
      await ready;
    }
  } catch {
    v.remove();
    URL.revokeObjectURL(url);
    throw fail;
  }
  let duration = v.duration;
  if (!isFinite(duration)) {
    // 일부 WebM은 길이 정보가 없다 → 끝까지 탐색해서 알아낸다
    v.currentTime = 1e7;
    await waitEvent(v, ['seeked'], 5000);
    duration = v.currentTime || 1;
  }
  let busy = Promise.resolve();
  const seek = (t) => {
    const target = Math.min(Math.max(0, t), Math.max(0, duration - 0.001));
    busy = busy.then(async () => {
      if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2) return;
      v.currentTime = target;
      // 탐색 완료 이벤트가 끝내 안 오는 기기도 있어서 멈추지 않도록 시간 제한
      await waitEvent(v, ['seeked'], 3000);
    });
    return busy;
  };
  await seek(Math.min(0.05, duration / 2));
  const thumb = snapshot(v, v.videoWidth, v.videoHeight);

  const nextPresented = () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    v.requestVideoFrameCallback((_, meta) => { clearTimeout(timer); resolve(meta.mediaTime); });
  });

  // 앞으로만 가는 구간은 매번 탐색(느림, 프레임당 ~100ms)하지 않고 재생하면서 뽑는다.
  // 소비자가 프레임을 처리하는 동안은 멈춰 두니 느린 폰에서도 프레임을 놓치지 않는다.
  async function* playRun(ts, rate) {
    v.pause();
    await seek(ts[0]);
    yield v;
    let i = 1;
    const step = ts.length > 1 ? ts[1] - ts[0] : 0.033;
    const tol = Math.min(0.02, step * 0.4);
    v.playbackRate = rate;
    while (i < ts.length) {
      const wait = nextPresented();
      try { await v.play(); } catch { /* 음소거라 막히지 않지만 혹시 몰라 */ }
      const mt = await wait;
      if (mt == null || v.ended) {
        // 프레임 콜백이 안 오면(백그라운드 탭 등) 남은 건 탐색으로
        v.pause();
        for (; i < ts.length; i++) { await seek(ts[i]); yield v; }
        return;
      }
      if (mt < ts[i] - tol) continue;
      v.pause();
      while (i < ts.length && mt >= ts[i] - tol) { yield v; i++; }
    }
    v.pause();
  }
  return {
    kind: 'video',
    name: file.name,
    fileSize: file.size,
    width: v.videoWidth,
    height: v.videoHeight,
    duration,
    element: v,
    thumb,
    heavy: file.size > HEAVY_VIDEO_MB * 1048576 || duration > 60 || Math.max(v.videoWidth, v.videoHeight) > 1920,
    async frameAt(t) { await seek(t); return v; },
    async *frames(ts) {
      const canPlay = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
      // 시간이 증가하는 덩어리로 나눈다 (부메랑의 거꾸로 부분은 탐색)
      let a = 0;
      while (a < ts.length) {
        let b = a + 1;
        while (b < ts.length && ts[b] > ts[b - 1]) b++;
        const run = ts.slice(a, b);
        if (canPlay && run.length >= 4) {
          const step = (run[run.length - 1] - run[0]) / (run.length - 1);
          const rate = Math.min(2, Math.max(0.25, step * 30));
          yield* playRun(run, rate);
        } else {
          for (const t of run) { await seek(t); yield v; }
        }
        a = b;
      }
    },
    dispose() { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url); },
  };
}

/* ---------- 사진 여러 장 ---------- */
async function decodeImage(file) {
  let blob = file;
  if (isHeic(file)) {
    try {
      return await createImageBitmap(file); // 사파리는 HEIC를 직접 연다
    } catch {
      await loadScript('vendor/heic2any.min.js');
      const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      blob = Array.isArray(out) ? out[0] : out;
    }
  }
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(blob);
  }
}

async function decodeAll(files) {
  const items = [];
  for (const f of files) {
    try {
      const bmp = await decodeImage(f);
      items.push({ bmp, name: f.name, thumb: snapshot(bmp, bmp.width, bmp.height, 160) });
    } catch {
      /* 못 읽는 파일은 건너뛴다 */
    }
  }
  return items;
}

/** 사진 소스에 사진을 더 붙인다. 추가된 장수를 돌려준다. */
export async function addImages(src, files) {
  const more = await decodeAll([...files].filter((f) => !isVideo(f)));
  src.items.push(...more);
  return more.length;
}

async function loadImages(files) {
  if (!files.length) throw new SourceError('영상이나 사진 파일을 골라 주세요.');
  const items = await decodeAll(files);
  if (!items.length) throw new SourceError('사진을 읽지 못했어요. JPG·PNG·HEIC 파일인지 확인해 주세요.');
  const src = {
    kind: 'images',
    name: `사진 ${items.length}장`,
    items,
    photoDur: 1,
    // 비율·크기는 첫 장 기준 (다른 비율의 사진은 맞춤 방식대로 들어간다)
    get width() { return items[0].bmp.width; },
    get height() { return items[0].bmp.height; },
    get duration() { return items.length * this.photoDur; },
    get thumb() { return items[0].thumb; },
    async frameAt(t) {
      const i = Math.min(items.length - 1, Math.max(0, Math.floor(t / this.photoDur + 1e-6)));
      return items[i].bmp;
    },
    async *frames(ts) { for (const t of ts) yield this.frameAt(t); },
    dispose() { items.forEach((i) => i.bmp.close?.()); },
  };
  return src;
}

/* ---------- GIF → GIF ---------- */
async function loadGif(file) {
  const { parseGIF, decompressFrames } = await import('../vendor/gifuct.js');
  const gif = parseGIF(await file.arrayBuffer());
  const raw = decompressFrames(gif, true);
  if (!raw.length) throw new SourceError('GIF 안에 프레임이 없어요.');
  const W = gif.lsd.width, H = gif.lsd.height;
  // GIF는 프레임이 "덧그리기"라서 한 장씩 합성해 완성된 화면을 만든다
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const patch = makeCanvas(W, H);
  const pctx = patch.getContext('2d');
  const frames = [];
  let t = 0;
  let restore = null;
  for (const f of raw) {
    const { width: fw, height: fh, top, left } = f.dims;
    if (restore) { ctx.putImageData(restore.data, restore.x, restore.y); restore = null; }
    if (f.disposalType === 3) restore = { data: ctx.getImageData(left, top, fw, fh), x: left, y: top };
    patch.width = fw; patch.height = fh;
    pctx.putImageData(new ImageData(f.patch, fw, fh), 0, 0);
    ctx.drawImage(patch, left, top);
    frames.push({ t, bmp: await createImageBitmap(canvas) });
    const delay = (f.delay || 100) / 1000;
    t += delay < 0.02 ? 0.1 : delay; // 브라우저들처럼 0.02초 미만은 0.1초로 본다
    if (f.disposalType === 2) ctx.clearRect(left, top, fw, fh);
  }
  const duration = t;
  return {
    kind: 'gif',
    name: file.name,
    fileSize: file.size,
    width: W,
    height: H,
    duration,
    frameCount: frames.length,
    thumb: snapshot(frames[0].bmp, W, H),
    async frameAt(time) {
      let lo = 0, hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (frames[mid].t <= time + 1e-6) lo = mid; else hi = mid - 1;
      }
      return frames[lo].bmp;
    },
    async *frames(ts) { for (const t of ts) yield this.frameAt(t); },
    dispose() { frames.forEach((f) => f.bmp.close?.()); },
  };
}

/* ---------- helpers ---------- */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** 여러 이벤트 중 하나가 오거나 시간이 지나면 끝난다 (실패로 보지 않음) */
function waitEvent(el, events, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); events.forEach((ev) => el.removeEventListener(ev, done)); resolve(); };
    const timer = setTimeout(done, ms);
    events.forEach((ev) => el.addEventListener(ev, done, { once: true }));
  });
}

function once(el, ev) {
  return new Promise((resolve) => el.addEventListener(ev, resolve, { once: true }));
}

function snapshot(drawable, w, h, max = 240) {
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(drawable, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

const loadedScripts = {};
function loadScript(src) {
  loadedScripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('script load failed'));
    document.head.appendChild(s);
  });
  return loadedScripts[src];
}
