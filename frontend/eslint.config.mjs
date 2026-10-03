import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// Flat config directly from eslint-config-next's own exports. The FlatCompat
// shim the Next template still prints needs `@eslint/eslintrc`, which is not a
// dependency here and does not need to become one.
export default [
  ...coreWebVitals,
  ...typescript,
  { ignores: [".next/**", "src/generated/**", "next-env.d.ts"] },
];
