import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied rather than called cross-origin. That keeps the
    // refresh cookie same-site in development exactly as it will be in
    // production behind one domain - otherwise SameSite=strict would silently
    // drop it and only local development would appear broken.
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
});
