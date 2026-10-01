import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    // 资源体积是本项目的关键约束，构建时开启体积报告
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1500,
  },
})
