import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-/, /katex/] } },
  },
})
