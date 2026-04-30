import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  ssr: {
    format: 'esm',
    noExternal: ['react', 'react-dom'],
  },
  build: {
    manifest: true,
    rollupOptions: {
      input: 'src/entry-client.jsx',
    },
  },
});
