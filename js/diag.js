// 진단 기록. 토스 앱 안처럼 개발자 도구를 못 여는 곳에서 어디서 막히는지 보려고 쓴다.
// 테스트용 번들(npm run build:debug)에서만 화면에 "진단 정보" 버튼이 나온다.

export const D = {
  env: {},
  decoder: '(아직 영상 안 열림)',
  source: {},
  convert: {},
  save: '(아직 저장 안 함)',
  errors: [],
};

export function note(section, values) {
  Object.assign(D[section], values);
}

export function setDecoderReason(reason) {
  D.decoder = reason;
}

export function setSave(msg) {
  D.save = msg;
}

window.addEventListener('error', (e) => D.errors.push(`error: ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => D.errors.push(`promise: ${e.reason?.message || e.reason}`));

export function collectEnv(extra = {}) {
  const has = (x) => (typeof x === 'undefined' ? '없음' : '있음');
  note('env', {
    ua: navigator.userAgent,
    VideoDecoder: has(window.VideoDecoder),
    VideoEncoder: has(window.VideoEncoder),
    EncodedVideoChunk: has(window.EncodedVideoChunk),
    rVFC: 'requestVideoFrameCallback' in HTMLVideoElement.prototype ? '있음' : '없음',
    hidden: document.visibilityState,
    ...extra,
  });
}

export function render() {
  const block = (title, obj) => `[${title}]\n` + Object.entries(obj).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return [
    block('환경', D.env),
    `[디코더]\n  ${D.decoder}`,
    block('원본', D.source),
    block('변환', D.convert),
    `[저장]\n  ${D.save}`,
    `[오류]\n  ${D.errors.slice(-8).join('\n  ') || '없음'}`,
  ].join('\n\n');
}
