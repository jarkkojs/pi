#!/usr/bin/env node
import { createHash } from "crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distBunDir = join(packageRoot, "dist", "bun");
const outFile = join(distBunDir, "embedded-assets.generated.js");

interface Asset {
	relPath: string;
	absPath: string;
}

function collectDir(absDir: string, relBase: string, out: Asset[]): void {
	for (const entry of readdirSync(absDir, { withFileTypes: true })) {
		const absPath = join(absDir, entry.name);
		const relPath = `${relBase}/${entry.name}`;
		if (entry.isDirectory()) {
			collectDir(absPath, relPath, out);
		} else if (entry.isFile()) {
			out.push({ relPath, absPath });
		}
	}
}

const assets: Asset[] = [];

for (const file of ["dark.json", "light.json", "theme-schema.json"]) {
	assets.push({ relPath: `theme/${file}`, absPath: join(packageRoot, "src/modes/interactive/theme", file) });
}
for (const entry of readdirSync(join(packageRoot, "src/modes/interactive/assets"), { withFileTypes: true })) {
	if (entry.isFile()) {
		assets.push({
			relPath: `assets/${entry.name}`,
			absPath: join(packageRoot, "src/modes/interactive/assets", entry.name),
		});
	}
}
assets.push({ relPath: "export-html/template.html", absPath: join(packageRoot, "src/core/export-html/template.html") });
for (const entry of readdirSync(join(packageRoot, "src/core/export-html/vendor"), { withFileTypes: true })) {
	if (entry.isFile()) {
		assets.push({
			relPath: `export-html/vendor/${entry.name}`,
			absPath: join(packageRoot, "src/core/export-html/vendor", entry.name),
		});
	}
}
assets.push({
	relPath: "photon_rs_bg.wasm",
	absPath: resolve(packageRoot, "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
});
collectDir(join(packageRoot, "docs"), "docs", assets);
collectDir(join(packageRoot, "examples"), "examples", assets);
assets.push({ relPath: "package.json", absPath: join(packageRoot, "package.json") });
assets.push({ relPath: "README.md", absPath: join(packageRoot, "README.md") });
assets.push({ relPath: "CHANGELOG.md", absPath: join(packageRoot, "CHANGELOG.md") });

assets.sort((a, b) => a.relPath.localeCompare(b.relPath));

const hash = createHash("sha256");
for (const asset of assets) {
	hash.update(asset.relPath);
	hash.update(String(statSync(asset.absPath).size));
}
const assetHash = hash.digest("hex").slice(0, 16);

const importLines: string[] = [];
const manifestLines: string[] = [];
assets.forEach((asset, i) => {
	const varName = `asset${i}`;
	let spec = relative(distBunDir, asset.absPath).split("\\").join("/");
	if (!spec.startsWith(".")) {
		spec = `./${spec}`;
	}
	importLines.push(`import ${varName} from ${JSON.stringify(spec)} with { type: "file" };`);
	manifestLines.push(`\t${JSON.stringify(asset.relPath)}: ${varName},`);
});

const content = `${importLines.join("\n")}\n\nexport const ASSET_HASH = ${JSON.stringify(assetHash)};\n\nexport const EMBEDDED_ASSETS = {\n${manifestLines.join("\n")}\n};\n`;

mkdirSync(distBunDir, { recursive: true });
writeFileSync(outFile, content);
console.log(`Generated ${outFile} with ${assets.length} embedded assets (hash ${assetHash})`);
