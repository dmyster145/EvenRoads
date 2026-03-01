import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { main: "index.html" },
    },
  },
});
