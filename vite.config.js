import { defineConfig } from "vite";

// The ngspice WASM build ships as one ~20 MB ES module with the binary inlined.
// It is pulled in with a dynamic import() from src/engine.js so it lands in its
// own chunk and the app shell paints before the engine is fetched.
export default defineConfig({
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
