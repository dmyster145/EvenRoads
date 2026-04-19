import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
