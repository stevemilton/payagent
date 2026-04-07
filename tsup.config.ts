import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/vercel.ts',
    'src/langchain.ts',
  ],
  format: ['esm'],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: ['ai', 'zod', 'zod/v4', 'zod/v3', '@langchain/core'],
});
