export default {
  '*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}': [
    'eslint --fix --no-warn-ignored',
    'prettier --write',
    'vitest related --run --passWithNoTests'
  ],
  '*.{json,jsonc,md,mdx,yml,yaml,css,scss,html}': 'prettier --write'
}
