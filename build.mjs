// Builds dist/manifest.js and dist/worker.js against the Paperclip SDK *source* at
// the exact commit the target server runs (PAPERCLIP_REF), so the bundled SDK speaks
// that server's protocol. The checkout is cached in .paperclip-src/.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const REF = process.env.PAPERCLIP_REF || "1b4c803816e82b0265c8422e1a804327a7ed8c54"; // ghcr.io/paperclipai/paperclip:2026.1023.0
const SRC = path.resolve(".paperclip-src");
const git = (...a) => execFileSync("git", a, { stdio: "inherit" });
if (!existsSync(SRC)) git("clone", "--filter=blob:none", "--no-checkout", "https://github.com/paperclipai/paperclip", SRC);
try { execFileSync("git", ["-C", SRC, "cat-file", "-e", `${REF}^{commit}`]); } catch { git("-C", SRC, "fetch", "-q", "origin", REF); }
git("-C", SRC, "checkout", "-q", REF);

const alias = {
  "@paperclipai/plugin-sdk": `${SRC}/packages/plugins/sdk/src/index.ts`,
  "@paperclipai/shared": `${SRC}/packages/shared/src/index.ts`,
};
const common = { bundle: true, format: "esm", platform: "node", target: "node24", outdir: "dist", alias, logLevel: "info" };
// The worker compares this with the commit the server reports, and says so when they differ.
await esbuild.build({ ...common, entryPoints: ["src/worker.ts"], external: ["react", "react-dom"], define: { __BUILT_FOR_PAPERCLIP__: JSON.stringify(REF) } });
await esbuild.build({ ...common, entryPoints: ["src/manifest.ts"], external: ["@paperclipai/plugin-sdk"] });
// Settings page: React and the SDK's UI module come from the host page.
await esbuild.build({
  entryPoints: ["src/ui/index.tsx"], outdir: "dist/ui", bundle: true, format: "esm", platform: "browser", target: "es2022",
  jsx: "automatic", logLevel: "info", external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui", "@paperclipai/plugin-sdk/ui/hooks"],
});
