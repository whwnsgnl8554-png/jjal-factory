# 짤공장 (gif-maker)

영상·사진을 올리고 플랫폼 버튼 하나만 누르면 그 규격에 맞춘 GIF / 루프 MP4가 나오는 정적 웹앱.
빌드 없음 — 이 폴더를 그대로 GitHub Pages에 올리면 된다. 파일은 서버로 가지 않고 브라우저 안에서만 변환.

## 구조
| 파일 | 역할 |
|---|---|
| `presets.json` | 플랫폼 규격. 규격이 바뀌면 이 파일만 고쳐 배포 (앱 재심사 없이) |
| `js/sources.js` | 입력 통일: 영상 / 사진 여러 장(HEIC 포함) / GIF → `frames(times)` |
| `js/compose.js` | 출력 크기·프레임 시간표·한 프레임 합성(맞춤/흐린 여백/자막). 미리보기와 변환이 같은 함수 사용 |
| `js/encoders.js` | GIF(워커) · MP4(WebCodecs H.264 + mp4-muxer), 용량 맞추기(FPS→크기→색상) |
| `js/gif-worker.js` | gifenc 인코딩, 같은 장면 연속 프레임은 합쳐서 용량 절약 |
| `vendor/` | gifenc, mp4-muxer, gifuct(번들), heic2any(HEIC일 때만 지연 로드) |

## 로컬 실행
`npx serve gif-maker -l 8800` (또는 `.claude/launch.json`의 `gif-maker`)

## 메모
- 영상 프레임은 "재생하면서 뽑기"(requestVideoFrameCallback) → 탐색 대비 약 3배 빠름. 탭이 가려지면 자동으로 탐색 방식으로 전환.
- 화질 모드: `applyQuality()`(compose.js) — 저용량 = 크기 60% · GIF 최대 10fps/128색 · MP4 최대 24fps·비트레이트 절반. 100MB 초과·60초 초과·긴 변 1920px 초과 영상은 저용량이 기본값(2GB까지 받음). 결과가 무거우면(GIF 8MB·MP4 30MB 초과) 결과 화면에서 '저용량 버전 만들기'를 강조.
- MP4는 WebCodecs가 없는 브라우저에선 GIF로 자동 전환. 소리는 넣지 않음.
- 앱인토스 전면형 광고 훅: `js/app.js`의 `maybeShowInterstitial()` (3회 변환당 1회). 배너 자리는 `index.html` 주석.
- 아직 안 한 것: 토스 SDK 연동·뒤로가기 브리지, WebP 출력, 디더링 옵션, 필터·워터마크(3차), 여러 프리셋 동시 출력, 카톡·네이버 실제 업로드 한도 실측.

## 앱인토스(토스 미니앱) 빌드
웹판 파일을 그대로 쓰고, `scripts/build-toss.mjs`가 `dist/`에 토스용 번들을 만든다.
```sh
npm install
npm run build      # dist/ 생성 → jjal-factory.ait
```
1. 앱인토스 콘솔에 등록한 appName을 `apps-in-toss.config.ts`의 `appName`에 맞춘다 (지금 `jjal-factory`).
2. 콘솔에서 광고 그룹 ID를 발급받아 `toss.config.json`에 넣는다 (비어 있으면 광고 없이 빌드).
   - `bannerAdGroupId`: 홈·규격 선택 화면 하단 배너 (한 화면에 1개)
   - `interstitialAdGroupId`: 변환 3번에 1번, 결과 화면으로 넘어가기 직전 전면 광고
3. `.ait`를 콘솔에 올리고 테스트 스킴으로 토스 앱에서 확인 → 검수 요청.

| 토스판에서 달라지는 점 | 처리 (`js/toss.js`) |
|---|---|
| 뒤로가기 | 토스 `backEvent` → 이전 단계, 홈에서만 `Screen.close`. 시트가 열려 있으면 시트부터 닫음. 브라우저 history는 쓰지 않음 |
| 저장 | `File.saveBase64`로 기기에 저장 (다운로드 링크 대신) |
| 영상 재생 | `allowsInlineMediaPlayback: true`, `mediaPlaybackRequiresUserAction: false` — 기본값이면 아이폰에서 영상 변환이 멈춤 |
| 규격 | GitHub Pages의 최신 `presets.json`을 먼저 시도, 실패하면 번들 내장본 |
| 약관 | 페이지 이동 대신 시트로 표시 |
| 기타 | 라이트 모드 고정, 핀치 줌 막기, 인앱 브라우저 전환 스크립트 제거 |
