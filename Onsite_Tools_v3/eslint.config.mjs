import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code worktrees carry their own full checkout (and .next output)
    // INSIDE the repo directory — without this, one background session makes
    // `npm run lint` report thousands of warnings from generated chunks.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
