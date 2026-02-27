import { build } from "esbuild";
import { cp, mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

async function listFiles(dir, ext) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath, ext)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(ext)) files.push(fullPath);
  }
  return files;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const htmlFiles = (await readdir(root)).filter((name) => name.endsWith(".html"));
  await Promise.all(htmlFiles.map((name) => cp(path.join(root, name), path.join(dist, name))));

  await cp(path.join(root, "assets"), path.join(dist, "assets"), { recursive: true });

  const jsEntries = await listFiles(path.join(root, "js"), ".js");
  const cssEntries = await listFiles(path.join(root, "css"), ".css");

  await build({
    entryPoints: jsEntries,
    outdir: path.join(dist, "js"),
    bundle: false,
    minify: true,
    sourcemap: false,
    target: "es2020",
    logLevel: "info"
  });

  await build({
    entryPoints: cssEntries,
    outdir: path.join(dist, "css"),
    bundle: false,
    minify: true,
    sourcemap: false,
    target: "es2020",
    logLevel: "info"
  });

  console.log(`Frontend build complete: ${dist}`);
}

main().catch((error) => {
  console.error("Frontend build failed:", error);
  process.exit(1);
});
