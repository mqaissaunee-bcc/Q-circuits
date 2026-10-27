import { defineConfig } from "vite";

// The ngspice WASM build ships as one ~20 MB ES module with the binary inlined.
// It is pulled in with a dynamic import() from src/engine.js so it lands in its
// own chunk and the app shell paints before the engine is fetched.
export default defineConfig({
  /*
   * The build stamp goes into the HTML itself rather than through `define`.
   * Whether a bare identifier is substituted inside a `typeof` check varies
   * between bundler versions, and a stamp that silently reads "dev" is worse
   * than none: it is the one thing that tells two deploys apart.
   */
  plugins: [{
    name: "build-stamp",
    transformIndexHtml(html) {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return html.replace('id="buildStamp">dev<', `id="buildStamp">${stamp} UTC<`);
    }
  }],
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 25000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("eecircuit-engine")) return "ngspice";
        }
      }
    }
  },
  server: { port: 5173 }
});
