import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8010",
        changeOrigin: true,
      },
    },
  },
  build: {
    // 重库 vendor 分包：Monaco / 图表 / PDF / 路由 / React，降低首屏与缓存粒度
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return "charts";
          if (
            id.includes("node_modules/jspdf") ||
            id.includes("node_modules/html2canvas") ||
            id.includes("node_modules/dompurify")
          )
            return "pdf";
          if (id.includes("node_modules/react-router")) return "router";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
          return undefined;
        },
      },
    },
  },
});
