#!/usr/bin/env node
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove build output.
 *
 * Written in Node rather than as a shell one-liner because `find` and `rm -rf`
 * do not exist on Windows, and npm runs scripts through `cmd.exe` there. A
 * clean step that only works on the maintainer's laptop is how a cross-platform
 * project quietly stops being cross-platform.
 *
 * Two jobs:
 *
 *   1. Delete `dist` and the incremental build info.
 *   2. Delete any compiled output that has ended up *inside* `src`. A stray
 *      `foo.js` next to `foo.ts` silently shadows the TypeScript during tests,
 *      so the suite passes against stale code - which has happened here before,
 *      and is the reason this runs automatically before every test run.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(packageRoot, "src");

const COMPILED = /\.(js|mjs|cjs|d\.ts|js\.map|d\.ts\.map)$/;

async function removeCompiledFrom(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;

  for (const entry of entries) {
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      removed += await removeCompiledFrom(target);
      continue;
    }

    // .ts survives; .d.ts does not, hence testing the longer suffix first.
    if (entry.name.endsWith(".d.ts") || (COMPILED.test(entry.name) && !entry.name.endsWith(".ts"))) {
      await fs.rm(target, { force: true });
      removed += 1;
    }
  }

  return removed;
}

const removed = await removeCompiledFrom(sourceDirectory);

await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
await fs.rm(path.join(packageRoot, "tsconfig.tsbuildinfo"), { force: true });

if (removed > 0) {
  console.log(`clean: removed ${removed} stray compiled file(s) from src/`);
}
