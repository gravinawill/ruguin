import { type Config } from 'prettier'

export const defineConfig = (config: Config = {}): Config => {
  const { plugins = [], ...rest } = config

  return {
    arrowParens: 'always',
    singleQuote: true,
    jsxSingleQuote: true,
    tabWidth: 2,
    semi: false,
    trailingComma: 'none',
    endOfLine: 'lf',
    plugins: ['prettier-plugin-packagejson', 'prettier-plugin-prisma', ...plugins],
    printWidth: 120,
    ...rest
  }
}
