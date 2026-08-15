import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome MV3 service workers have no `document`. Disabling Vite's
    // module-preload shim keeps the background entry worker-safe while modern
    // Chrome loads the popup and analytics modules natively.
    modulePreload: false,
    chunkSizeWarningLimit: 1000, // Suppresses the >500kB warning for background bundle
    rollupOptions: {
      input: {
        background: path.resolve(import.meta.dirname, 'src/background/background.ts'),
        content: path.resolve(import.meta.dirname, 'src/content/content.ts'),
        popup: path.resolve(import.meta.dirname, 'popup.html'),
        analytics: path.resolve(import.meta.dirname, 'analytics.html'),
        onboarding: path.resolve(import.meta.dirname, 'onboarding.html'),
        offscreen: path.resolve(import.meta.dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
