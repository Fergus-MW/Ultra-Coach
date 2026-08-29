const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

module.exports = [
  ...expoConfig,
  prettier,
  {
    // The PWA lints itself, under its own Next config.
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'web/*'],
  },
];
