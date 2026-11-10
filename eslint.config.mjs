import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// Next 16 dropped `next lint`; this is the same setup for ESLint 9 itself
// (npm run lint runs `eslint .`): Next's core web vitals rules, and no em or
// en dashes anywhere.
export default defineConfig([
  ...nextVitals,
  {
    rules: {
      // eslint-config-next 16 brings eslint-plugin-react-hooks 7, whose new
      // rules are written for the React Compiler, which this app doesn't use.
      // Three of them flag patterns the app relies on as it is (an effect
      // that sets state when a prop changes, a ref read during render in the
      // demo harness); changing those is its own change, not the upgrade's.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/\\u2014|\\u2013/]",
          message: "No em or en dashes anywhere, including UI copy. Use a comma, a colon, or a full stop.",
        },
      ],
    },
  },
  globalIgnores(["node_modules/**", ".next/**", "src/lib/db/migrations/**", "next-env.d.ts"]),
]);
