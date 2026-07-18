import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import renderJavaScriptVisitor from "@codama/renderers-js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlDir = join(__dirname, "../src/core/solana/idl");
const generatedDir = join(__dirname, "../src/core/solana/generated");

const programs = [
  { idl: "agentic_commerce_v3.json", out: "acp" },
  { idl: "fund_transfer_hook.json", out: "fund-transfer-hook" },
];

for (const { idl, out } of programs) {
  const raw = JSON.parse(readFileSync(join(idlDir, idl), "utf-8"));
  const rootNode = rootNodeFromAnchor(raw);
  const codama = createFromRoot(rootNode);
  codama.accept(renderJavaScriptVisitor(join(generatedDir, out)));
  console.log(`Generated ${out} client`);
}
