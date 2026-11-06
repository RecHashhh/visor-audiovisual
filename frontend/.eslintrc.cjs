// Revisión mínima que corre antes de cada build (local y en GitHub Actions):
// atrapa variables y componentes no definidos, que Vite compila sin quejarse
// y que en producción dejan la página en blanco. No es una guía de estilo.
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: 'detect' } },
  plugins: ['react', 'react-hooks'],
  rules: {
    'no-undef': 'error',
    'react/jsx-no-undef': 'error',
    'react/jsx-uses-vars': 'error',
    'react/jsx-uses-react': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'public/'],
}
