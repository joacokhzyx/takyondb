// Vitest discovers this config from the package root automatically.
// Plain object on purpose: importing 'vitest/config' would require module
// resolution tricks because test sources live outside the package root.
export default {
    test: {
        include: ['../client/**/*.test.ts', '../*.test.ts'],
    },
};
