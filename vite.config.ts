import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: ".",
  server: {
    host: true,
    port: 5173,
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "",
    rollupOptions: {
      input: { main: "index.html" },
    },
  },
});
