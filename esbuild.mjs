import { build } from 'esbuild'

await build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  outfile: 'dist/handler.js',
  format: 'cjs',
  sourcemap: true,
  minify: true,
  external: []
})
