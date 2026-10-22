// vendor/mp4box.js 를 다시 만들 때: node scripts/vendor-mp4box.mjs
import { build } from 'esbuild';
await build({
  stdin: { contents: "export { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', minify: true, target: ['es2020', 'safari15'], outfile: 'vendor/mp4box.js', logLevel: 'warning',
});
console.log('✔ vendor/mp4box.js');
