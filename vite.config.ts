import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [cloudflare()],
  worker: { format: "es" },
  build: { target: "es2022" },
  // The HTML inputs belong to the client environment only; set at the top
  // level they'd also be applied to the Worker build and fail to resolve.
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: resolve(__dirname, "index.html"),
            map: resolve(__dirname, "tools/map.html"),
            view: resolve(__dirname, "tools/view.html"),
            actors: resolve(__dirname, "tools/actors.html"),
            nav: resolve(__dirname, "tools/nav.html"),
            play: resolve(__dirname, "tools/play.html"),
            audio: resolve(__dirname, "tools/audio.html"),
          },
        },
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
