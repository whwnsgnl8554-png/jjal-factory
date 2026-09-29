import { loadSource, addImages, SourceError } from './sources.js';
import { outputSize, outputDuration, drawFrame, estimateMB, applyQuality, RATIOS, TEXT_FONT } from './compose.js';
import { makeGif, makeMp4, mp4Supported, Cancelled } from './encoders.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const BG_COLORS = ['#000000', '#ffffff', '#f2f4f6', '#3182f6', '#ffe45c', '#ff8fab'];
const TEXT_COLORS = ['#ffffff', '#111111', '#ffe45c', '#3182f6', '#ff5f8f'];
const MP4_MAX_SEC = 60;
const TIPS = [
  '카톡은 ‘원본’ 화질로 보내야 움짤이 움직여요.',
  '지금 이 파일은 서버가 아니라 이 기기 안에서 구워지고 있어요.',
  '3~5초짜리 짤이 가장 여러 번 돌려 보게 돼요.',
  '쇼츠·릴스는 끝과 처음이 자연스럽게 이어지면 반복 시청이 늘어요.',
  'GIF는 색이 최대 256개라, 노을 같은 그라데이션은 살짝 계단져 보일 수 있어요.',
  '용량이 크면 ‘고급 설정’에서 fps를 낮추는 게 화질 손해가 가장 적어요.',
];

const state = {
  presets: [],
  groups: [],
  src: null,
  preset: null,
  s: null,
  result: null,
  resultUrl: null,
  step: 'home',
  preselect: null,
  abort: null,
  conversions: 0,
};

/* =========================================================
   프리셋
   ========================================================= */
async function loadPresets() {
  // 규격이 바뀌면 presets.json만 고쳐서 배포하면 된다 (앱 재심사 없이)
  const res = await fetch('presets.json', { cache: 'no-cache' });
  const data = await res.json();
  state.presets = data.presets;
  state.groups = data.groups;
}
const presetById = (id) => state.presets.find((p) => p.id === id);

function recentIds() {
  try { return JSON.parse(localStorage.getItem('jjal.recent') || '[]'); } catch { return []; }
}
function pushRecent(id) {
  try {
    const ids = [id, ...recentIds().filter((x) => x !== id)].slice(0, 3);
    localStorage.setItem('jjal.recent', JSON.stringify(ids));
  } catch { /* 저장 못 해도 괜찮다 */ }
}

/* =========================================================
   화면 이동 (뒤로가기 = 이전 단계, 홈에서만 앱 종료)
   ========================================================= */
const ORDER = ['home', 'preset', 'edit', 'working', 'result'];

function show(step) {
  state.step = step;
  document.body.dataset.step = step;
  $$('.step').forEach((el) => (el.hidden = el.dataset.step !== step));
  $('#backBtn').hidden = step === 'home' || step === 'working';
  const cur = step === 'working' ? 'edit' : step;
  $$('.steps li').forEach((li) => {
    li.classList.toggle('on', li.dataset.dot === cur);
    li.classList.toggle('done', ORDER.indexOf(li.dataset.dot) < ORDER.indexOf(cur));
  });
  if (step === 'edit') startPreview(); else stopPreview();
  window.scrollTo(0, 0);
}

function go(step) {
  history.pushState({ step }, '');
  show(step);
}

window.addEventListener('popstate', (e) => {
  const step = e.state?.step || 'home';
  if (state.step === 'working') {
    // 변환 중 뒤로가기 = 그만두기
    state.abort?.abort();
    history.pushState({ step: 'edit' }, '');
    show('edit');
    return;
  }
  if (step !== 'home' && !state.src) { show('home'); return; }
  if ((step === 'edit' || step === 'result') && !state.preset) { show('preset'); return; }
  if (step === 'result' && !state.result) { show('edit'); return; }
  show(step);
});

/* =========================================================
   1. 홈 — 파일 받기
   ========================================================= */
function renderRecent() {
  const ids = recentIds().filter(presetById);
  $('#recentWrap').hidden = !ids.length;
  $('#recentChips').innerHTML = ids.map((id) => {
    const p = presetById(id);
    return `<button class="chip${state.preselect === id ? ' on' : ''}" data-id="${id}">${p.emoji} ${p.name}</button>`;
  }).join('');
}
$('#recentChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.preselect = state.preselect === b.dataset.id ? null : b.dataset.id;
  renderRecent();
  if (state.preselect) toast(`${presetById(state.preselect).name} 규격으로 바로 만들어요. 파일을 올려 주세요!`);
});

async function takeFiles(files) {
  if (!files?.length) return;
  toast('파일 여는 중…', 8000);
  try {
    const src = await loadSource(files);
    state.src?.dispose();
    state.src = src;
    state.result = null;
    hideToast();
    renderSrcCard();
    if (src.heavy) setTimeout(() => toast('큰 영상이라 저용량으로 맞춰 둘게요. 편집 화면에서 기본 화질로 바꿀 수 있어요.', 4500), 300);
    if (state.preselect) {
      applyPreset(presetById(state.preselect));
      history.pushState({ step: 'preset' }, '');
      go('edit');
    } else {
      go('preset');
    }
  } catch (err) {
    console.error(err);
    toast(err instanceof SourceError ? err.message : '파일을 열지 못했어요. 다른 파일로 해 볼까요?', 4000);
  }
}

$('#fileInput').addEventListener('change', (e) => { takeFiles(e.target.files); e.target.value = ''; });
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('over')));
dz.addEventListener('drop', (e) => { e.preventDefault(); takeFiles(e.dataTransfer.files); });

/* =========================================================
   2. 프리셋 선택
   ========================================================= */
function fmtSec(t) { return `${(Math.round(t * 10) / 10).toFixed(1)}초`; }
function fmtMB(mb) { return mb < 1 ? `${Math.max(1, Math.round(mb * 1024))}KB` : `${mb.toFixed(mb < 10 ? 1 : 0)}MB`; }

function renderSrcCard() {
  const src = state.src;
  const kind = { video: '영상', images: '사진', gif: 'GIF' }[src.kind];
  const detail = src.kind === 'images'
    ? `${src.items.length}장 · 움직이는 앨범으로 만들어요`
    : `${kind} · ${fmtSec(src.duration)} · ${src.width}×${src.height}`;
  $('#srcCard').innerHTML = `<img src="${src.thumb}" alt="" /><div><b>${escapeHtml(src.name)}</b><span>${detail}</span></div>`;
}

function renderPresets() {
  const byGroup = (g) => state.presets.filter((p) => p.group === g);
  const card = (p) => `
    <button class="pcard${p.group === 'custom' ? ' custom' : ''}" data-id="${p.id}" style="--tint:${p.tint}">
      <span class="ico">${p.emoji}</span>
      ${p.group === 'custom' ? '<div>' : ''}<b>${p.name}</b><span>${p.sub}</span>${p.group === 'custom' ? '</div>' : ''}
      ${p.group !== 'custom' ? `<em class="fmt">${p.format === 'mp4' ? 'MP4' : 'GIF'}</em>` : ''}
    </button>`;
  $('#presetGroups').innerHTML = state.groups.map((g) => `
    <div class="group-title">${g.title}</div>
    <p class="group-note">${g.note}</p>
    <div class="grid">${byGroup(g.id).map(card).join('')}</div>`).join('')
    + `<div class="grid" style="margin-top:10px">${byGroup('custom').map(card).join('')}</div>`;
}
$('#presetGroups').addEventListener('click', (e) => {
  const b = e.target.closest('.pcard');
  if (!b) return;
  applyPreset(presetById(b.dataset.id));
  go('edit');
});

/* =========================================================
   3. 편집 — 설정
   ========================================================= */
function maxOutSec(s = state.s) {
  return s.format === 'mp4' ? Math.max(state.preset.maxDuration, state.preset.group === 'custom' ? MP4_MAX_SEC : 0) : state.preset.maxDuration;
}

function applyPreset(p) {
  const src = state.src;
  const prev = state.s;
  state.preset = p;
  const outRatio = p.ratio === 'orig' ? src.width / src.height : RATIOS[p.ratio];
  const srcRatio = src.width / src.height;
  const mismatch = Math.max(outRatio / srcRatio, srcRatio / outRatio);
  let format = p.format;
  if (format === 'mp4' && !mp4Supported()) format = 'gif';
  const s = {
    format,
    width: p.width,
    ratio: p.ratio,
    fps: p.fps,
    speed: src.kind === 'images' ? 1 : prev?.speed ?? 1,
    start: 0,
    end: 0,
    fit: src.kind === 'video' && mismatch > 1.4 ? 'blur' : 'cover',
    bgColor: '#000000',
    focusX: 0.5,
    focusY: 0.5,
    repeat: 'inf',
    repeatN: 3,
    boomerang: prev?.boomerang ?? false,
    colors: p.id === 'emoji' ? 128 : 256,
    quality: prev ? prev.quality : src.heavy ? 'low' : 'normal',
    targetMB: p.targetMB,
    fitSize: !!p.targetMB,
    text: prev?.text ?? '',
    textPos: prev?.textPos ?? 'bottom',
    textSize: prev?.textSize ?? 'm',
    textColor: prev?.textColor ?? '#ffffff',
    textOutline: prev?.textOutline ?? true,
    safeArea: p.safeArea || null,
  };
  state.s = s;
  if (src.kind === 'images') {
    // 사진은 "한 장당 시간"으로 길이가 정해진다. 목표 길이에 맞춰 기본값을 잡는다.
    const per = Math.min(2, Math.max(0.3, p.duration / src.items.length));
    src.photoDur = prev ? src.photoDur : Math.round(per * 10) / 10;
    s.end = src.duration;
  } else {
    const keepStart = prev && prev.start < src.duration ? prev.start : 0;
    s.start = keepStart;
    s.end = Math.min(src.duration, keepStart + p.duration * s.speed);
    if (s.end - s.start < 0.2) { s.start = 0; s.end = Math.min(src.duration, p.duration * s.speed); }
  }
  pushRecent(p.id);
  syncControls();
}

function clampTrim(changed) {
  const s = state.s, src = state.src;
  const maxSpan = maxOutSec() * s.speed;
  const minSpan = Math.min(0.2, src.duration);
  if (s.end - s.start > maxSpan) {
    if (changed === 'start') s.end = s.start + maxSpan; else s.start = s.end - maxSpan;
  }
  if (s.end - s.start < minSpan) {
    if (changed === 'start') s.start = Math.max(0, s.end - minSpan); else s.end = Math.min(src.duration, s.start + minSpan);
  }
  s.start = Math.max(0, s.start);
  s.end = Math.min(src.duration, s.end);
}

function setSeg(id, value) {
  $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));
}
function onSeg(id, fn) {
  $(`#${id}`).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    fn(b.dataset.v);
    syncControls();
  });
}
function swatches(id, colors, current) {
  $(`#${id}`).innerHTML = colors.map((c) => `<button class="sw${c === current ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="색 ${c}"></button>`).join('');
}

/** 상태 → 화면 컨트롤 */
function syncControls() {
  const s = state.s, src = state.src, p = state.preset;
  const isGif = s.format === 'gif';
  const isImg = src.kind === 'images';
  $('#editPreset').textContent = `${p.emoji} ${p.name}`;

  // 구간 / 사진
  $('#trimCard').hidden = isImg;
  $('#photoCard').hidden = !isImg;
  if (isImg) {
    renderThumbs();
    $('#photoDur').value = Math.round(src.photoDur * 10);
    $('#photoDurOut').textContent = fmtSec(src.photoDur);
    s.start = 0; s.end = src.duration;
  } else {
    const k = 1000 / src.duration;
    $('#trimStart').value = Math.round(s.start * k);
    $('#trimEnd').value = Math.round(s.end * k);
    $('#trimFill').style.left = `${(s.start / src.duration) * 100}%`;
    $('#trimFill').style.right = `${100 - (s.end / src.duration) * 100}%`;
    $('#tStart').textContent = fmtSec(s.start);
    $('#tEnd').textContent = fmtSec(s.end);
    $('#tLen').textContent = `${fmtSec((s.end - s.start) / s.speed)} 짤`;
    $('#trimLabel').textContent = `최대 ${maxOutSec()}초`;
    $('#trimHint').textContent = src.duration > maxOutSec() * s.speed
      ? `${p.name}용은 최대 ${maxOutSec()}초까지예요. 파란 구간을 끌어서 원하는 장면을 골라요.`
      : '';
  }

  setSeg('fitSeg', s.fit);
  $('#bgRow').hidden = s.fit !== 'solid';
  swatches('bgSwatches', BG_COLORS, s.bgColor);

  $('#textInput').value = s.text;
  $('#textOpts').style.display = s.text.trim() ? '' : 'none';
  setSeg('textPosSeg', s.textPos);
  setSeg('textSizeSeg', s.textSize);
  swatches('textSwatches', TEXT_COLORS, s.textColor);
  $('#textOutline').checked = s.textOutline;

  setSeg('qualitySeg', s.quality);
  $('#qualityHint').textContent = s.quality === 'low'
    ? (isGif ? '크기 60% · 최대 10fps · 128색으로 가볍게 만들어요. 카톡·블로그에서 빨리 떠요.' : '크기 60% · 최대 24fps · 비트레이트 절반으로 가볍게 만들어요. 올릴 때 앱이 알아서 키워요.')
    : (src.heavy ? '큰 영상은 기본 화질로 만들면 느리거나 폰이 버거워할 수 있어요.' : '');

  $('#sizeCard').hidden = !isGif;
  $('#fitSize').checked = s.fitSize;
  $('#targetMB').value = s.targetMB ?? 5;
  $('#targetMB').disabled = !s.fitSize;

  setSeg('formatSeg', s.format);
  $('#formatSeg button[data-v="mp4"]').disabled = !mp4Supported();
  setSeg('ratioSeg', s.ratio);
  $('#widthRange').value = s.width;
  const { width: W, height: H } = outputSize(applyQuality(s), src);
  $('#widthOut').textContent = `${W}×${H}`;
  setSeg('fpsSeg', s.fps);
  $('#speedField').hidden = isImg;
  const si = SPEEDS.indexOf(s.speed);
  $('#speedRange').value = si < 0 ? 3 : si;
  $('#speedOut').textContent = `${s.speed}x`;
  setSeg('repeatSeg', s.repeat);
  $('#repeatNRow').hidden = s.repeat !== 'n';
  $('#repeatN').value = s.repeatN;
  $('#repeatHint').textContent = isGif
    ? ''
    : '영상은 올린 곳에서 알아서 반복돼요. ‘N번’을 고르면 내용을 N번 이어 붙여 길게 만들어요.';
  $('#boomerang').checked = s.boomerang;
  $('#colorsField').hidden = !isGif;
  setSeg('colorsSeg', s.colors);

  $('#makeBtn').textContent = isGif ? 'GIF 만들기' : '루프 영상 만들기';
  updateMeta();
  preview.dirty = true;
}

function updateMeta() {
  const s = applyQuality(state.s), src = state.src;
  const { width: W, height: H } = outputSize(s, src);
  const dur = outputDuration(s, src) * (s.format === 'mp4' && s.repeat === 'n' ? s.repeatN : 1);
  const mb = estimateMB(s, src);
  let size = `예상 약 ${fmtMB(mb)}`;
  if (s.format === 'gif' && s.targetMB) {
    if (s.fitSize && mb > s.targetMB) size = `목표 ${s.targetMB}MB에 맞춰 줄여요`;
    else if (!s.fitSize && mb > s.targetMB) size = `<span class="over">예상 약 ${fmtMB(mb)} · 권장 ${s.targetMB}MB 초과</span>`;
  }
  $('#metaLine').innerHTML = `<b>${W}×${H}</b> · ${fmtSec(dur)} · ${s.fps}fps · ${size}`;
}

/* ---- 컨트롤 → 상태 ---- */
function bindControls() {
  const trimInput = (which) => (e) => {
    const src = state.src, s = state.s;
    const t = (e.target.value / 1000) * src.duration;
    if (which === 'start') s.start = Math.min(t, s.end - 0.05); else s.end = Math.max(t, s.start + 0.05);
    clampTrim(which);
    preview.scrub = which === 'start' ? s.start : Math.max(s.start, s.end - 0.05);
    syncControls();
  };
  $('#trimStart').addEventListener('input', trimInput('start'));
  $('#trimEnd').addEventListener('input', trimInput('end'));
  ['change', 'pointerup', 'touchend'].forEach((ev) => {
    $('#trimStart').addEventListener(ev, () => { preview.scrub = null; preview.restart = true; });
    $('#trimEnd').addEventListener(ev, () => { preview.scrub = null; preview.restart = true; });
  });
  // 두 핸들이 겹치면 가까운 쪽이 잡히도록
  $('#trim').addEventListener('pointerdown', (e) => {
    const r = $('#trim').getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * state.src.duration;
    const nearStart = Math.abs(t - state.s.start) <= Math.abs(t - state.s.end);
    $('#trimStart').style.zIndex = nearStart ? 3 : 2;
    $('#trimEnd').style.zIndex = nearStart ? 2 : 3;
  }, true);

  $('#photoDur').addEventListener('input', (e) => {
    state.src.photoDur = e.target.value / 10;
    state.s.end = state.src.duration;
    syncControls();
  });
  $('#addPhotos').addEventListener('change', async (e) => {
    const n = await addImages(state.src, e.target.files);
    e.target.value = '';
    toast(n ? `${n}장 더 넣었어요` : '사진을 읽지 못했어요');
    renderSrcCard();
    syncControls();
  });

  onSeg('fitSeg', (v) => (state.s.fit = v));
  onSeg('qualitySeg', (v) => (state.s.quality = v));
  $('#bgSwatches').addEventListener('click', (e) => { const c = e.target.dataset.c; if (c) { state.s.bgColor = c; syncControls(); } });
  $('#textInput').addEventListener('input', (e) => {
    state.s.text = e.target.value;
    $('#textOpts').style.display = state.s.text.trim() ? '' : 'none';
    document.fonts?.load(`800 40px ${TEXT_FONT}`, state.s.text).then(() => (preview.dirty = true));
    preview.dirty = true;
  });
  onSeg('textPosSeg', (v) => (state.s.textPos = v));
  onSeg('textSizeSeg', (v) => (state.s.textSize = v));
  $('#textSwatches').addEventListener('click', (e) => { const c = e.target.dataset.c; if (c) { state.s.textColor = c; syncControls(); } });
  $('#textOutline').addEventListener('change', (e) => { state.s.textOutline = e.target.checked; syncControls(); });

  $('#fitSize').addEventListener('change', (e) => { state.s.fitSize = e.target.checked; if (!state.s.targetMB) state.s.targetMB = 5; syncControls(); });
  $('#targetMB').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v > 0) { state.s.targetMB = v; updateMeta(); } });

  onSeg('formatSeg', (v) => {
    state.s.format = v;
    if (v === 'mp4' && state.s.fps < 24) state.s.fps = 30;
    clampTrim('end');
  });
  onSeg('ratioSeg', (v) => { state.s.ratio = v; state.s.focusX = state.s.focusY = 0.5; });
  $('#widthRange').addEventListener('input', (e) => { state.s.width = +e.target.value; syncControls(); });
  onSeg('fpsSeg', (v) => (state.s.fps = +v));
  $('#speedRange').addEventListener('input', (e) => {
    const s = state.s;
    s.speed = SPEEDS[+e.target.value];
    clampTrim('end');
    preview.restart = true;
    syncControls();
  });
  onSeg('repeatSeg', (v) => (state.s.repeat = v));
  $('#repeatN').addEventListener('input', (e) => { state.s.repeatN = Math.max(2, Math.min(10, +e.target.value || 2)); updateMeta(); });
  $('#boomerang').addEventListener('change', (e) => { state.s.boomerang = e.target.checked; syncControls(); });
  onSeg('colorsSeg', (v) => (state.s.colors = +v));

  $('#changePreset').addEventListener('click', () => history.back());
  $('#makeBtn').addEventListener('click', () => convert());
}

/* ---- 사진 순서 바꾸기 (끌어서) ---- */
function renderThumbs() {
  const items = state.src.items;
  $('#thumbs').innerHTML = items.map((it, i) => `
    <div class="thumb" data-i="${i}"><img src="${it.thumb}" alt="${i + 1}번 사진" /><span class="n">${i + 1}</span><button class="x" aria-label="${i + 1}번 사진 빼기">×</button></div>`).join('');
}
function bindThumbDrag() {
  const box = $('#thumbs');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x')) return;
    const el = e.target.closest('.thumb');
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    drag = { el, x0: e.clientX, moved: false };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 6) return;
    drag.moved = true;
    drag.el.classList.add('lift');
    const others = [...box.children].filter((c) => c !== drag.el);
    const before = others.find((c) => { const r = c.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    if (before) { if (drag.el.nextSibling !== before) box.insertBefore(drag.el, before); }
    else if (box.lastElementChild !== drag.el) box.appendChild(drag.el);
    // 가장자리로 끌면 줄을 스크롤
    const br = box.getBoundingClientRect();
    if (e.clientX < br.left + 30) box.scrollLeft -= 8;
    if (e.clientX > br.right - 30) box.scrollLeft += 8;
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag.el.classList.remove('lift');
    drag = null;
    if (!moved) return;
    const order = [...box.children].map((c) => +c.dataset.i);
    const items = state.src.items;
    const next = order.map((i) => items[i]);
    items.splice(0, items.length, ...next);
    renderSrcCard();
    syncControls();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (!x) return;
    const items = state.src.items;
    if (items.length <= 1) { toast('사진이 한 장은 있어야 해요'); return; }
    const i = +x.parentElement.dataset.i;
    items.splice(i, 1)[0].bmp.close?.();
    renderSrcCard();
    syncControls();
  });
}

/* =========================================================
   미리보기 — 실제 변환과 같은 drawFrame으로 그린다
   ========================================================= */
const preview = { raf: 0, dirty: true, t0: 0, lastTick: -1, geo: null, playing: true, scrub: null, restart: true, busy: false };
const pcanvas = $('#preview');
const pctx = pcanvas.getContext('2d');

function startPreview() {
  if (!state.src || !state.s) return;
  cancelAnimationFrame(preview.raf);
  preview.restart = true;
  preview.dirty = true;
  const tick = async (now) => {
    preview.raf = requestAnimationFrame(tick);
    if (preview.busy) return;
    preview.busy = true;
    try { await drawPreview(now); } finally { preview.busy = false; }
  };
  preview.raf = requestAnimationFrame(tick);
}
function stopPreview() {
  cancelAnimationFrame(preview.raf);
  preview.raf = 0;
  if (state.src?.kind === 'video') state.src.element.pause();
}

async function drawPreview(now) {
  const s = applyQuality(state.s), src = state.src;
  const out = outputSize(s, src);
  const k = Math.min(1, 720 / Math.max(out.width, out.height));
  const W = Math.round(out.width * k), H = Math.round(out.height * k);
  if (pcanvas.width !== W || pcanvas.height !== H) { pcanvas.width = W; pcanvas.height = H; preview.dirty = true; }
  const safe = $('#safeArea');
  safe.hidden = !s.safeArea;
  if (s.safeArea) { safe.style.top = `${s.safeArea.top * 100}%`; safe.style.bottom = `${s.safeArea.bottom * 100}%`; }

  if (preview.restart) { preview.t0 = now; preview.lastTick = -1; preview.restart = false; }
  const span = Math.max(0.05, s.end - s.start);
  let img;

  if (src.kind === 'video') {
    const v = src.element;
    v.playbackRate = s.speed;
    if (preview.scrub != null) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - preview.scrub) > 0.03 && !v.seeking) v.currentTime = preview.scrub;
      preview.dirty = true;
    } else if (preview.playing) {
      if (v.currentTime >= s.end - 0.02 || v.currentTime < s.start - 0.1 || v.ended || preview.lastTick === -1) {
        if (!v.seeking) v.currentTime = s.start;
      }
      if (v.paused && !v.seeking) v.play().catch(() => {});
    } else if (!v.paused) v.pause();
    const tickN = Math.floor(v.currentTime * s.fps / s.speed);
    if (tickN === preview.lastTick && !preview.dirty) return;
    preview.lastTick = tickN;
    img = v;
  } else {
    // 사진·GIF: 시간을 직접 계산 (부메랑도 미리보기)
    const elapsed = preview.playing ? ((now - preview.t0) / 1000) * s.speed : (preview.pausedAt || 0);
    if (preview.playing) preview.pausedAt = elapsed;
    const tickN = Math.floor((elapsed / s.speed) * s.fps);
    if (tickN === preview.lastTick && !preview.dirty) return;
    preview.lastTick = tickN;
    const snapped = (tickN / s.fps) * s.speed;
    let ph;
    if (s.boomerang) { const c = snapped % (2 * span); ph = c < span ? c : 2 * span - c; } else ph = snapped % span;
    img = await src.frameAt(s.start + ph);
  }
  preview.geo = drawFrame(pctx, W, H, img, s);
  preview.scale = k;
  preview.dirty = false;
  const draggable = s.fit === 'cover' && (preview.geo.slackX > 1 || preview.geo.slackY > 1);
  $('#stageFrame').classList.toggle('draggable', draggable);
  $('#dragHint').hidden = !draggable;
}

function bindStage() {
  const frame = $('#stageFrame');
  let d = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.play-btn')) return;
    const g = preview.geo;
    if (!g || state.s.fit !== 'cover' || (g.slackX <= 1 && g.slackY <= 1)) return;
    frame.setPointerCapture(e.pointerId);
    d = { x: e.clientX, y: e.clientY, fx: state.s.focusX, fy: state.s.focusY, ratio: pcanvas.width / pcanvas.getBoundingClientRect().width };
    $('#dragHint').classList.add('gone');
  });
  frame.addEventListener('pointermove', (e) => {
    if (!d) return;
    const g = preview.geo;
    const dx = (e.clientX - d.x) * d.ratio, dy = (e.clientY - d.y) * d.ratio;
    if (g.slackX > 1) state.s.focusX = Math.min(1, Math.max(0, d.fx - dx / g.slackX));
    if (g.slackY > 1) state.s.focusY = Math.min(1, Math.max(0, d.fy - dy / g.slackY));
    preview.dirty = true;
  });
  const up = () => (d = null);
  frame.addEventListener('pointerup', up);
  frame.addEventListener('pointercancel', up);

  $('#playBtn').addEventListener('click', () => {
    preview.playing = !preview.playing;
    if (preview.playing) { preview.t0 = performance.now() - ((preview.pausedAt || 0) / state.s.speed) * 1000; }
    $('#playBtn').setAttribute('aria-label', preview.playing ? '일시정지' : '재생');
    $('#playIcon').innerHTML = preview.playing
      ? '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>'
      : '<path d="M8 5l11 7-11 7z" fill="currentColor"/>';
    preview.dirty = true;
  });
}

/* =========================================================
   4. 변환
   ========================================================= */
let tipTimer = 0;
async function convert({ fromResult = false } = {}) {
  const s = { ...state.s };
  const src = state.src;
  if (s.text.trim()) await document.fonts?.load(`800 40px ${TEXT_FONT}`, s.text).catch(() => {});
  show('working');
  $('#wBar').style.width = '0%';
  $('#wPct').textContent = '0%';
  $('#wLabel').textContent = '재료 준비 중';
  let ti = Math.floor(Math.random() * TIPS.length);
  $('#wTip').textContent = TIPS[ti];
  clearInterval(tipTimer);
  tipTimer = setInterval(() => { ti = (ti + 1) % TIPS.length; $('#wTip').textContent = TIPS[ti]; }, 4000);

  const abort = new AbortController();
  state.abort = abort;
  const onProgress = ({ ratio, label }) => {
    const pct = Math.round(ratio * 100);
    $('#wBar').style.width = `${pct}%`;
    $('#wPct').textContent = `${pct}%`;
    $('#wLabel').textContent = label;
  };
  const t0 = performance.now();
  try {
    const result = s.format === 'mp4'
      ? await makeMp4(src, s, { onProgress, signal: abort.signal })
      : await makeGif(src, s, { onProgress, signal: abort.signal });
    result.ms = performance.now() - t0;
    result.format = s.format;
    result.requested = s;
    state.result = result;
    state.conversions++;
    await maybeShowInterstitial();
    renderResult();
    // 결과 화면에서 다시 만든 경우엔 결과 기록을 덮어써서 뒤로가기가 꼬이지 않게
    if (fromResult) history.replaceState({ step: 'result' }, ''); else history.pushState({ step: 'result' }, '');
    show('result');
  } catch (err) {
    if (err instanceof Cancelled || abort.signal.aborted) {
      if (state.step === 'working') show(fromResult && state.result ? 'result' : 'edit');
      toast('변환을 멈췄어요');
    } else if (err.message === 'NO_WEBCODECS' || err.message === 'NO_H264') {
      state.s.format = 'gif';
      state.s.fps = Math.min(state.s.fps, 15);
      syncControls();
      show('edit');
      toast('이 브라우저는 MP4를 못 만들어요. GIF로 바꿔 뒀어요.', 4000);
    } else {
      console.error(err);
      show('edit');
      toast('변환 중에 문제가 생겼어요. 구간을 짧게 하거나 크기를 줄여 다시 해 볼까요?', 4500);
    }
  } finally {
    clearInterval(tipTimer);
    state.abort = null;
  }
}
$('#cancelBtn').addEventListener('click', () => state.abort?.abort());

// 앱인토스 전면형 광고 자리: 3회 변환당 1회, 변환 완료 → 결과 화면 전환 때.
async function maybeShowInterstitial() {
  if (state.conversions % 3 !== 0) return;
  // TODO(앱인토스): 인앱 광고 SDK 연결 시 여기서 전면형 광고를 띄우고 닫힐 때까지 기다린다.
}

/* =========================================================
   5. 결과
   ========================================================= */
function fileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `jjal_${state.preset.id}_${stamp}.${state.result.format === 'mp4' ? 'mp4' : 'gif'}`;
}

function renderResult() {
  const r = state.result, p = state.preset;
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(r.blob);
  $('#resultMedia').innerHTML = r.format === 'mp4'
    ? `<video src="${state.resultUrl}" autoplay loop muted playsinline></video>`
    : `<img src="${state.resultUrl}" alt="만들어진 움짤" />`;
  const mb = r.blob.size / 1048576;
  const target = r.requested.targetMB;
  const cls = target ? (mb <= target ? 'good' : 'bad') : '';
  $('#stats').innerHTML = `
    <div class="${cls}"><b>${fmtMB(mb)}</b><span>${target ? `목표 ${target}MB` : '용량'}</span></div>
    <div><b>${r.width}×${r.height}</b><span>크기</span></div>
    <div><b>${fmtSec(r.duration)}</b><span>${r.fps}fps · ${(r.ms / 1000).toFixed(1)}초 만에</span></div>`;
  const notes = [];
  if (r.overTarget) notes.push(`목표 ${target}MB까지는 못 줄였어요. 구간을 짧게 하거나 ‘고급 설정’에서 크기를 줄여 보세요.`);
  const used = r.settings;
  const base = applyQuality(r.requested);
  if (r.format === 'gif' && used && (used.fps !== base.fps || used.scale !== base.scale || used.colors !== base.colors)) {
    const bits = [];
    if (used.fps !== base.fps) bits.push(`${used.fps}fps`);
    if (used.scale !== base.scale) bits.push(`${r.width}×${r.height}`);
    if (used.colors !== base.colors) bits.push(`${used.colors}색`);
    if (!r.overTarget) $('#resultTitle').textContent = '용량까지 딱 맞췄어요!';
    notes.unshift(`용량을 맞추느라 ${bits.join(' · ')}(으)로 살짝 줄였어요.`);
  } else {
    $('#resultTitle').textContent = '다 됐어요!';
  }
  // 저용량 버전 버튼: 이미 저용량이면 숨기고, 용량이 크면 눈에 띄게
  const lowBtn = $('#lowBtn');
  const heavyOut = r.overTarget || mb > (r.format === 'gif' ? 8 : 30);
  lowBtn.hidden = r.requested.quality === 'low';
  lowBtn.classList.toggle('urge', heavyOut);
  lowBtn.textContent = heavyOut ? `${fmtMB(mb)}는 좀 무거워요 → 저용량 버전 만들기` : '저용량 버전도 만들기';
  if (r.requested.quality === 'low') notes.push('저용량으로 만들었어요. 화질이 아쉬우면 ‘설정 고쳐서 다시’에서 기본 화질로 바꿔 보세요.');
  if (r.format === 'mp4') notes.push('루프 영상에는 소리가 들어가지 않아요. 음악은 올리는 앱에서 붙이면 돼요.');
  $('#resultWarn').hidden = !notes.length;
  $('#resultWarn').innerHTML = notes.join('<br />');
  $('#resultWarn').style.cssText = r.overTarget ? '' : 'background:var(--bg-soft);color:var(--text-2)';

  const file = new File([r.blob], fileName(), { type: r.blob.type });
  state.resultFile = file;
  $('#shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#guideBtn').textContent = `${p.emoji} ${p.name}에 올리는 법`;
  $('#againChips').innerHTML = state.presets
    .filter((x) => x.id !== p.id && x.group !== 'custom')
    .map((x) => `<button class="chip" data-id="${x.id}">${x.emoji} ${x.name}</button>`).join('');
  confetti();
}

$('#saveBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = state.resultUrl;
  a.download = state.resultFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const p = state.preset;
  if (p.afterSave) openGuide(p.afterSave);
  else toast('저장했어요! 갤러리나 다운로드 폴더를 확인해 보세요');
});
$('#shareBtn').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [state.resultFile], title: '짤공장에서 만든 움짤' });
  } catch (e) {
    if (e.name !== 'AbortError') toast('공유를 열지 못했어요. 저장 후 앱에서 올려 주세요');
  }
});
$('#guideBtn').addEventListener('click', () => openGuide());
$('#lowBtn').addEventListener('click', () => {
  state.s.quality = 'low';
  syncControls();
  convert({ fromResult: true });
});
$('#againChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  applyPreset(presetById(b.dataset.id));
  history.back(); // 결과 → 편집 (새 규격으로)
});
$('#reEditBtn').addEventListener('click', () => history.back());
$('#newFileBtn').addEventListener('click', resetToHome);

function resetToHome() {
  state.src?.dispose();
  state.src = null;
  state.s = null;
  state.preset = null;
  state.result = null;
  history.replaceState({ step: 'home' }, '');
  renderRecent();
  show('home');
}

/* =========================================================
   바텀시트 · 토스트 · 기타
   ========================================================= */
function openGuide(callout) {
  const p = state.preset;
  $('#sheetTitle').textContent = `${p.name}에 올리는 법`;
  $('#sheetBody').innerHTML = (callout ? `<div class="callout">⚠️ ${callout}</div>` : '')
    + `<ol>${p.guide.map((g) => `<li>${g}</li>`).join('')}</ol>`;
  $('#sheet').hidden = false;
  $('#sheetDim').hidden = false;
  $('#sheetOk').focus();
}
function closeSheet() { $('#sheet').hidden = true; $('#sheetDim').hidden = true; }
$('#sheetOk').addEventListener('click', closeSheet);
$('#sheetDim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function hideToast() { $('#toast').classList.remove('show'); }

function confetti() {
  const box = $('.confetti');
  const colors = ['#3182f6', '#ff5f8f', '#ffb03a', '#7c5cff', '#00b76a'];
  box.innerHTML = Array.from({ length: 22 }, (_, i) => {
    const x = (Math.random() - 0.5) * 320, y = 40 + Math.random() * 90, r = Math.random() * 540 - 270;
    return `<i style="left:50%;background:${colors[i % 5]};--x:${x}px;--y:${y}px;--r:${r}deg;animation-delay:${Math.random() * 0.15}s"></i>`;
  }).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#backBtn').addEventListener('click', () => history.back());
$('#brand').addEventListener('click', () => { if (state.step !== 'working' && state.step !== 'home') resetToHome(); });

/* =========================================================
   시작
   ========================================================= */
(async function init() {
  history.replaceState({ step: 'home' }, '');
  show('home');
  bindControls();
  bindThumbDrag();
  bindStage();
  try {
    await loadPresets();
  } catch {
    toast('규격 정보를 불러오지 못했어요. 새로고침해 주세요', 5000);
    return;
  }
  renderPresets();
  renderRecent();
})();
