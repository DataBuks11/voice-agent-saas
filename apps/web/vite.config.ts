import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
  server: { port: 5173 },
  build: {
    outDir: process.env.VITE_OUT_DIR || "dist",
    emptyOutDir: true,
  },
});
