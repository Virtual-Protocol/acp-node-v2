import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import renderJavaScriptVisitor from "@codama/renderers-js";
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlDir = join(__dirname, "../src/core/solana/idl");
const generatedDir = join(__dirname, "../src/core/solana/generated");

const programs = [
  { idl: "agentic_commerce_v3.json", out: "acp" },
  { idl: "fund_transfer_hook.json", out: "fund-transfer-hook" },
  { idl: "multi_hook_router.json", out: "multi-hook-router" },
  { idl: "subscription_hook.json", out: "subscription-hook" },
  { idl: "subscription_state.json", out: "subscription-state" },
];

/**
 * Codama emits extensionless relative imports. This package is "nodenext", so
 * TypeScript rejects those (TS2834/TS2835). Rewrite each one to the explicit
 * specifier nodenext wants: a directory becomes "<dir>/index.js", a module
 * becomes "<file>.js".
 *
 * The codama versions are pinned exactly in package.json rather than by range.
 * Renderer output is not stable across minor versions -- 1.6 drops the event
 * codecs in types/ that this SDK decodes job events with -- so a floating range
 * silently changes what lands here.
 */
function fixImports(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      fixImports(p);
      continue;
    }
    if (!p.endsWith(".ts")) continue;
    const src = readFileSync(p, "utf-8");
    const out = src.replace(/(from\s+")(\.[^"]*)(")/g, (m, pre, spec, post) => {
      if (/\.(js|json)$/.test(spec)) return m;
      let target: string;
      try {
        target = statSync(resolve(dirname(p), spec)).isDirectory()
          ? `${spec}/index.js`
          : `${spec}.js`;
      } catch {
        target = `${spec}.js`;
      }
      return pre + target + post;
    });
    if (out !== src) writeFileSync(p, out);
  }
}

for (const { idl, out } of programs) {
  const raw = JSON.parse(readFileSync(join(idlDir, idl), "utf-8"));
  const rootNode = rootNodeFromAnchor(raw);
  const codama = createFromRoot(rootNode);
  // The render visitor is async -- await it, or fixImports runs against a
  // directory the renderer has deleted and not yet refilled.
  await codama.accept(renderJavaScriptVisitor(join(generatedDir, out)));
  fixImports(join(generatedDir, out));
  console.log(`Generated ${out} client`);
}
