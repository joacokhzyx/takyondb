// ESLint flat config for the TakyonDB TypeScript SDK.
// Run via `npm run lint` (executes from this directory so every source
// file lives inside the config base path).
const tsParser = require('./ts/node_modules/@typescript-eslint/parser/dist/index.js');
const tsPlugin = require('./ts/node_modules/@typescript-eslint/eslint-plugin/dist/index.js');

module.exports = [
    {
        ignores: ['ts/dist/**', 'ts/node_modules/**', 'ts/coverage/**', 'bindings/**'],
    },
    {
        files: ['client/**/*.ts', 'takyon.ts', 'index.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs['recommended'].rules,
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
];
