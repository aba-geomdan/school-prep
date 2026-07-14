import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import obfuscator from 'vite-plugin-javascript-obfuscator';

// https://vitejs.dev/config/
// 저장소명에 맞춘 GitHub Pages base path.
// 배포 URL: https://aba-geomdan.github.io/school-prep/
export default defineConfig({
  plugins: [
    react(),
    obfuscator({
      apply: 'build',
      include: [/\.js$/],
      exclude: [/node_modules/],
      debugger: false,
      options: {
        compact: true,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        identifierNamesGenerator: 'hexadecimal',
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        selfDefending: false,
      },
    }),
  ],
  base: '/school-prep/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 단일 번들로 출력해 GitHub Pages에서 단순한 정적 호스팅
    chunkSizeWarningLimit: 2000,
  },
});
