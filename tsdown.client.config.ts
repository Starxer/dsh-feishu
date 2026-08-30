import { defineConfig } from 'tsdown'

const moduleId = '@starxer/chatterbox4dsh'
const externals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  clean: true,
  dts: false,
  sourcemap: true,
  external: externals,
  noExternal: ['qrcode.react'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(moduleId)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
