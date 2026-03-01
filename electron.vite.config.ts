import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: "electron/main/index.ts",
      },
      outDir: "out/main",
    },
  },
  preload: {
    build: {
      lib: {
        entry: "electron/preload/index.ts",
      },
      outDir: "out/preload",
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      outDir: "out/renderer",
    },
  },
});
