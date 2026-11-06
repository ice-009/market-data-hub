import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "data/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // The scrubber in src/log.ts is the only sanctioned way to write logs from the server.
      "no-console": "error",
    },
  },
  // The CLI talks to a human in a terminal.
  { files: ["src/cli.ts"], rules: { "no-console": "off" } },
);
