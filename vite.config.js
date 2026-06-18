import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// 저장소명에 맞춘 GitHub Pages base path.
// 배포 URL: https://aba-geomdan.github.io/school-prep/
export default defineConfig({
  plugins: [react()],
  base: '/school-prep/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 단일 번들로 출력해 GitHub Pages에서 단순한 정적 호스팅
    chunkSizeWarningLimit: 2000,
  },
});
