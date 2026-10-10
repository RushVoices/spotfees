import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills({ include: ["buffer", "crypto", "stream", "util"] })],
  build: { target: "es2020" },
});
