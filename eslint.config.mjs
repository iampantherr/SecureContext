/**
 * ESLint flat config — v0.17.1+ (L3 architectural lint)
 * ======================================================
 *
 * PURPOSE:
 *   Enforce @typescript-eslint/no-floating-promises across src/.
 *   Catches async calls without await — the class of bug that silently
 *   dropped outcome-resolver writes for 9 months (see
 *   ARCHITECTURAL_LESSONS.md L3).
 */

import tseslint from "typescript-eslint";

const config = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/**/*.test.ts",
      "scripts/**",
    ],
  },
];

// Spread typescript-eslint recommended configs
for (const c of tseslint.configs.recommended) {
  config.push(c);
}

config.push({
  files: ["src/**/*.ts"],
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": ["error", {
      ignoreVoid: true,
      ignoreIIFE: true,
    }],
    // Mute unrelated noise — we just want the floating-promise rule right now.
    "@typescript-eslint/no-explicit-any":         "off",
    "@typescript-eslint/no-unused-vars":          "off",
    "@typescript-eslint/no-require-imports":      "off",
    "@typescript-eslint/no-unsafe-function-type": "off",
    "@typescript-eslint/ban-ts-comment":          "off",
    "@typescript-eslint/no-empty-object-type":    "off",
    "no-empty":                                   "off",
    "no-useless-escape":                          "off",
    "prefer-const":                               "off",
    "no-case-declarations":                       "off",
  },
});

export default config;
