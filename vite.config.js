import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import obfuscator from "vite-plugin-javascript-obfuscator";

// GitHub Pages: https://aba-geomdan.github.io/esdm/ 로 배포하므로 base = "/esdm/"
// 저장소 이름을 바꾸면 이 값도 같이 바꿔야 함.
export default defineConfig({
  plugins: [
    react(),
    obfuscator({
      apply: "build",
      include: [/\.js$/],
      exclude: [/node_modules/],
      debugger: false,
      options: {
        compact: true,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        stringArrayThreshold: 0.75,
        identifierNamesGenerator: "hexadecimal",
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        selfDefending: false,
      },
    }),
  ],
  base: "/esdm/",
});
