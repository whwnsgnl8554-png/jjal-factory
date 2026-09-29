import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  // ⚠️ 앱인토스 콘솔에 등록한 appName과 똑같이 맞춰 주세요.
  appName: 'jjal-factory',
  brand: {
    primaryColor: '#3182F6',
  },
  navigationBar: {
    theme: 'light',
  },
  webView: {
    // 영상에서 프레임을 뽑으려면 음소거 영상을 화면 안에서(전체화면 없이) 자동 재생할 수 있어야 해요.
    // 기본값(false / true)이면 아이폰에서 영상 변환이 멈춰요.
    allowsInlineMediaPlayback: true,
    mediaPlaybackRequiresUserAction: false,
    // 단계 이동은 토스 뒤로가기 이벤트로 처리하므로 웹뷰 스와이프 뒤로가기는 끈다
    allowsBackForwardNavigationGestures: false,
    bounces: false,
    overScrollMode: 'never',
  },
  // 파일은 <input type="file">(시스템 선택창)로 받아서 따로 권한이 필요 없어요.
  permissions: [],
  webBundleDir: 'dist',
});
