import { create } from "archiver";
import { createWriteStream, existsSync } from "fs";
import fs from "fs-extra";
import { join, resolve } from "path";
import { version } from "../../../package.json" with { type: "json" };

async function zipPlugin() {
  const pluginDir = resolve(import.meta.dir, "..");
  // bun.config.ts writes main.js next to manifest.json at the repository root
  const rootDir = resolve(pluginDir, "../..");

  const releaseDir = join(pluginDir, "releases");
  fs.ensureDirSync(releaseDir);

  const zipFilePath = join(releaseDir, `obsidian-plugin-${version}.zip`);
  const output = createWriteStream(zipFilePath);

  const archive = create("zip", { zlib: { level: 9 } });
  archive.on("warning", (error) => {
    throw error;
  });
  archive.pipe(output);

  // Add the required files
  for (const name of ["main.js", "manifest.json"]) {
    const path = join(rootDir, name);
    if (!existsSync(path)) throw new Error(`${path} is missing; build the plugin first`);
    archive.file(path, { name });
  }
  // The plugin has no stylesheet today; include one if it is added.
  const styles = join(rootDir, "styles.css");
  if (existsSync(styles)) archive.file(styles, { name: "styles.css" });

  await archive.finalize();
  console.log(`Plugin files zipped to ${zipFilePath}`);
}

zipPlugin().catch((error) => {
  console.error(error);
  process.exit(1);
});
