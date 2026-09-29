// 앱인토스 SDK 중 짤공장이 쓰는 기능만 묶어서 window.__AIT__로 내보내요.
// (앱 코드는 번들러 없이 도는 ES 모듈이라, SDK는 이 파일로만 들어온다)
import {
  graniteEvent,
  closeView,
  Screen,
  File,
  TossAds,
  loadFullScreenAd,
  showFullScreenAd,
} from '@apps-in-toss/web-framework';

window.__AIT__ = { graniteEvent, closeView, Screen, File, TossAds, loadFullScreenAd, showFullScreenAd };
