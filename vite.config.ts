import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const mathText = fileURLToPath(new URL("src/components/MathText.tsx", import.meta.url));
const katexModule = fileURLToPath(new URL("src/lib/katex.ts", import.meta.url));
/**
 * Builds KaTeX as a chunk of its own and gives MathText its URL. A browser keeps a failed
 * import() of a URL for the life of the page, so MathText retries a failed download with a
 * new query string, which needs the chunk's URL rather than import("../lib/katex").
 */
function katexChunk(): Plugin {
  const source = 'new URL("../lib/katex.ts", import.meta.url).href';
  return {
    name: "bell:katex-chunk",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (id !== mathText) return;
      if (!code.includes(source)) this.error(`MathText must locate KaTeX with ${source}`);
      const chunk = this.emitFile({ type: "chunk", id: katexModule, name: "katex", preserveSignature: "strict" });
      return { code: code.replace(source, `import.meta.ROLLUP_FILE_URL_${chunk}`), map: null };
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), katexChunk()],
  // MathText imports KaTeX by URL, which the dev server's dependency scan cannot follow.
  optimizeDeps: { include: ["katex"] },
  // The CSP allows fonts only from 'self': KaTeX's smallest fonts must stay files, not data: URIs.
  build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined) },
  server: {
    port: 5173,
    strictPort: true,
    // The API listens on BELL_PORT from .env (`npm run dev` loads it), 3001 by default.
    proxy: { "/api": `http://127.0.0.1:${loadEnv(mode, process.cwd(), "BELL_").BELL_PORT?.trim() || 3001}` },
  },
}));
