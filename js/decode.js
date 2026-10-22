// 영상 파일(MP4·MOV)을 <video> 재생 없이 WebCodecs로 직접 디코드해서 프레임을 뽑는다.
// 토스 같은 인앱 웹뷰는 숨겨진 <video>를 재생·탐색해도 화면이 갱신되지 않아
// 모든 프레임이 같은 그림(= 움직이지 않는 GIF)이 되는 일이 있어서, 변환은 이 경로를 먼저 쓴다.

let mp4boxModule;
const loadMp4box = () => (mp4boxModule ||= import('../vendor/mp4box.js'));

/** 최상위 박스(ftyp·moov·mdat…) 위치만 훑는다. 영상 본문(mdat)은 읽지 않는다. */
async function scanTopBoxes(file) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= file.size && boxes.length < 64) {
    const dv = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = dv.getUint32(0);
    const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
    if (size === 1 && dv.byteLength >= 16) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - off;
    if (size < 8) break;
    boxes.push({ type, off, size });
    off += size;
  }
  return boxes;
}

function rotationOf(matrix) {
  if (!matrix) return 0;
  const a = matrix[0] / 65536, b = matrix[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}

/**
 * 디코더를 준비한다. 지원하지 않는 파일·기기면 null (그러면 기존 <video> 경로로 간다).
 * 반환: { width, height, frames(ts) } — width/height는 회전을 반영한 화면 기준 크기
 */
export async function openVideoDecoder(file) {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return null;
  if (!/mp4|quicktime|m4v/i.test(file.type) && !/\.(mp4|mov|m4v)$/i.test(file.name)) return null;

  const boxes = await scanTopBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov || moov.size > 64 * 1048576) return null;

  const { createFile, DataStream, Endianness, MP4BoxBuffer } = await loadMp4box();
  const iso = createFile();
  let info = null;
  iso.onReady = (i) => { info = i; };
  iso.onError = () => {};
  // 폰으로 찍은 영상은 moov(목차)가 영상 본문(mdat) 뒤에 있는 경우가 많다.
  // mp4box는 이어진 데이터를 기대하므로 ftyp+moov만 붙여 한 덩어리로 준다.
  // (프레임 위치는 moov 안에 절대 위치로 적혀 있어서 그대로 맞는다)
  const head = boxes.filter((x) => x.type === 'ftyp' || x.type === 'moov');
  const parts = await Promise.all(head.map((b) => file.slice(b.off, b.off + b.size).arrayBuffer()));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { joined.set(new Uint8Array(p), at); at += p.byteLength; }
  iso.appendBuffer(MP4BoxBuffer.fromArrayBuffer(joined.buffer, 0));
  iso.flush();
  const track = info?.videoTracks?.[0];
  if (!track) return null;
  const trak = iso.getTrackById(track.id);
  const samples = trak.samples || [];
  if (!samples.length) return null;

  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const confBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (confBox) {
    const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    confBox.write(ds);
    description = new Uint8Array(ds.buffer, 8); // 박스 헤더 8바이트 제외
  }
  const codedWidth = entry.width || track.video?.width;
  const codedHeight = entry.height || track.video?.height;
  const config = { codec: track.codec, codedWidth, codedHeight, description };
  try {
    const ok = await VideoDecoder.isConfigSupported(config);
    if (!ok.supported) return null;
  } catch { return null; }

  const rot = rotationOf(track.matrix);
  const swap = rot === 90 || rot === 270;
  const width = swap ? codedHeight : codedWidth;
  const height = swap ? codedWidth : codedHeight;
  const timeOf = (s) => s.cts / s.timescale;

  // 디코더가 내준 프레임을 회전까지 반영해 그려 둘 캔버스 (소비자는 이걸 drawImage 한다)
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const paint = (frame) => {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const fw = frame.displayWidth, fh = frame.displayHeight;
    ctx.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
    ctx.restore();
    return canvas;
  };

  const keyIndexBefore = (t) => {
    let k = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].is_sync && timeOf(samples[i]) <= t + 1e-3) k = i;
      if (timeOf(samples[i]) > t + 5) break;
    }
    return k;
  };

  /** 시간이 증가하는 목표 시각들 → 각 시각에 화면에 보일 프레임을 순서대로 내준다 */
  async function* decodeRun(ts) {
    const out = [];
    let err = null;
    let wake = null;
    const decoder = new VideoDecoder({
      output: (f) => { out.push(f); wake?.(); },
      error: (e) => { err = e; wake?.(); },
    });
    decoder.configure(config);
    let feed = keyIndexBefore(ts[0]);
    let flushed = false;
    let prev = null;
    const nextFrame = async () => {
      while (!out.length) {
        if (err) throw err;
        if (feed < samples.length) {
          // 몇 개씩 넣고, 디코더가 밀리면 기다린다
          for (let n = 0; n < 4 && feed < samples.length; n++, feed++) {
            const s = samples[feed];
            const data = new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
            decoder.decode(new EncodedVideoChunk({
              type: s.is_sync ? 'key' : 'delta',
              timestamp: Math.round((1e6 * s.cts) / s.timescale),
              duration: Math.round((1e6 * s.duration) / s.timescale),
              data,
            }));
          }
          if (decoder.decodeQueueSize > 6 || !out.length) {
            await new Promise((r) => { wake = r; setTimeout(r, 30); });
            wake = null;
          }
        } else if (!flushed) {
          flushed = true;
          await decoder.flush();
        } else {
          return null;
        }
      }
      return out.shift();
    };
    try {
      let i = 0;
      while (i < ts.length) {
        const f = await nextFrame();
        if (!f) break;
        const ft = f.timestamp / 1e6;
        // 이 프레임이 목표 시각을 넘어섰으면, 목표 시각엔 직전 프레임이 보이고 있던 것
        while (i < ts.length && ts[i] < ft - 1e-3) { yield paint(prev || f); i++; }
        prev?.close();
        prev = f;
      }
      while (i < ts.length && prev) { yield paint(prev); i++; }
    } finally {
      prev?.close();
      out.forEach((f) => f.close());
      if (decoder.state !== 'closed') decoder.close();
    }
  }

  return {
    width,
    height,
    async *frames(ts) {
      // 앞으로 가는 구간은 한 번에, 거꾸로 가는 구간(부메랑)은 프레임마다 가까운 키프레임부터 디코드
      let a = 0;
      while (a < ts.length) {
        let b = a + 1;
        while (b < ts.length && ts[b] > ts[b - 1]) b++;
        yield* decodeRun(ts.slice(a, b));
        a = b;
      }
    },
  };
}
