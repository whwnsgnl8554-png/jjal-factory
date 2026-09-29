// 토스(앱인토스) 안에서만 달라지는 것들을 한곳에 모았다.
// 웹(GitHub Pages)에서는 window.__AIT__가 없어서 전부 기존 웹 동작으로 돌아간다.
//   - 화면 이동: 웹은 브라우저 기록(history), 토스는 내부 스택 + 토스 뒤로가기 이벤트
//   - 저장: 웹은 다운로드 링크, 토스는 File.saveBase64
//   - 광고: 토스에서 광고 ID가 설정된 경우에만

export const AIT = window.__AIT__ || null;
const CONFIG = window.__JJAL_TOSS__ || {};
export const inToss = !!AIT;

/* ---------- 화면 이동 ---------- */
/**
 * onBack(step): 뒤로 가서 도착한 단계를 알려 준다.
 * 토스에서 홈에서 뒤로가기를 누르면 미니앱을 닫는다.
 */
export function createNav(onBack) {
  if (!AIT) {
    const safe = (fn) => { try { fn(); } catch { /* 일부 웹뷰는 history 조작이 막혀 있다 */ } };
    window.addEventListener('popstate', (e) => onBack(e.state?.step || 'home'));
    return {
      push: (step) => safe(() => history.pushState({ step }, '')),
      replace: (step) => safe(() => history.replaceState({ step }, '')),
      reset: (step) => safe(() => history.replaceState({ step }, '')),
      back: () => history.back(),
    };
  }
  const stack = ['home'];
  const nav = {
    push: (step) => { stack.push(step); },
    replace: (step) => { stack[stack.length - 1] = step; },
    reset: (step) => { stack.length = 0; stack.push(step); },
    back: () => {
      if (stack.length <= 1) { closeApp(); return; }
      stack.pop();
      // 호출한 쪽의 흐름이 끝난 뒤 처리 (웹의 popstate처럼 비동기로)
      setTimeout(() => onBack(stack[stack.length - 1]), 0);
    },
  };
  return nav;
}

export function onSystemBack(handler) {
  if (!AIT?.graniteEvent) return;
  try {
    AIT.graniteEvent.addEventListener('backEvent', { onEvent: handler, onError: () => {} });
  } catch { /* 구독 실패 시 토스 기본 동작 */ }
}

function closeApp() {
  try {
    if (AIT.Screen?.close) AIT.Screen.close();
    else AIT.closeView?.();
  } catch { /* 닫기 실패는 무시 */ }
}

/* ---------- 저장 ---------- */
export function canNativeSave() {
  try { return !!AIT?.File?.saveBase64?.isSupported?.(); } catch { return false; }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** 토스 기기 저장. 성공하면 true */
export async function nativeSave(blob, fileName) {
  const data = await blobToBase64(blob);
  await AIT.File.saveBase64({ data, fileName, mimeType: blob.type });
  return true;
}

/* ---------- 규격 원격 갱신 ---------- */
/** 토스 번들은 GitHub Pages의 최신 presets.json을 먼저 시도한다 (앱 재심사 없이 규격 갱신) */
export function presetUrls() {
  return CONFIG.presetsUrl ? [CONFIG.presetsUrl, 'presets.json'] : ['presets.json'];
}

/* ---------- 광고 ---------- */
let bannerDone = false;
export function attachBanner(target) {
  if (!AIT || !CONFIG.bannerAdGroupId || bannerDone) return;
  try {
    const { TossAds } = AIT;
    if (!TossAds?.attachBanner?.isSupported?.()) return;
    bannerDone = true;
    const attach = () => {
      TossAds.attachBanner(CONFIG.bannerAdGroupId, target, {
        theme: 'light',
        callbacks: { onNoFill: () => target.classList.add('empty'), onAdFailedToRender: () => target.classList.add('empty') },
      });
      target.hidden = false;
    };
    if (TossAds.initialize?.isSupported?.()) {
      TossAds.initialize({ callbacks: { onInitialized: attach, onInitializationFailed: () => {} } });
    } else attach();
  } catch { /* 광고 실패가 앱을 멈추게 하지 않는다 */ }
}

let interstitialReady = false;
export function preloadInterstitial() {
  if (!AIT || !CONFIG.interstitialAdGroupId || interstitialReady) return;
  try {
    if (!AIT.loadFullScreenAd?.isSupported?.()) return;
    AIT.loadFullScreenAd({
      options: { adGroupId: CONFIG.interstitialAdGroupId },
      onEvent: (e) => { if (e.type === 'loaded') interstitialReady = true; },
      onError: () => { interstitialReady = false; },
    });
  } catch { /* 무시 */ }
}

/** 미리 불러온 전면 광고가 있으면 보여 주고 닫힐 때까지 기다린다. 없으면 바로 끝난다. */
export function showInterstitial() {
  if (!AIT || !interstitialReady) return Promise.resolve(false);
  interstitialReady = false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (shown) => {
      if (settled) return;
      settled = true;
      preloadInterstitial(); // 다음 번 광고 준비
      resolve(shown);
    };
    setTimeout(() => done(false), 60000); // 광고가 응답이 없어도 결과 화면은 나오게
    try {
      AIT.showFullScreenAd({
        options: { adGroupId: CONFIG.interstitialAdGroupId },
        onEvent: (e) => { if (e.type === 'dismissed' || e.type === 'failedToShow') done(e.type === 'dismissed'); },
        onError: () => done(false),
      });
    } catch { done(false); }
  });
}
