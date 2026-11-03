import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({base:"./",plugins:[react()],build:{outDir:"dist",emptyOutDir:true,assetsInlineLimit:10000000,rollupOptions:{output:{inlineDynamicImports:true}}}});
