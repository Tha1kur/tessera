import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Repository } from "../src/repository.js";
import type { Identity } from "../src/objects/types.js";

/** A fixed identity, so commit ids are reproducible across runs. */
export const TEST_AUTHOR: Identity = {
  name: "Test Author",
  email: "test@example.com",
  timestamp: 1_700_000_000_000,
  timezoneOffset: 0,
};

/** An identity a fixed number of seconds after the base one, for ordering. */
export function authorAt(secondsLater: number): Identity {
  return { ...TEST_AUTHOR, timestamp: TEST_AUTHOR.timestamp + secondsLater * 1000 };
}

export interface TestRepository {
  readonly repository: Repository;
  readonly directory: string;
  write(relativePath: string, contents: string): Promise<void>;
  read(relativePath: string): Promise<string>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

/** Create a real repository in a throwaway directory. */
export async function createTestRepository(): Promise<TestRepository> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-test-"));
  // macOS reports /var but resolves to /private/var; normalise so that the
  // path comparisons inside Repository line up.
  const resolved = await fs.realpath(directory);
  const repository = await Repository.initialise(resolved);

  const absolute = (relativePath: string) => path.join(resolved, ...relativePath.split("/"));

  return {
    repository,
    directory: resolved,

    async write(relativePath, contents) {
      const target = absolute(relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    },

    async read(relativePath) {
      return fs.readFile(absolute(relativePath), "utf8");
    },

    async remove(relativePath) {
      await fs.rm(absolute(relativePath), { recursive: true, force: true });
    },

    async exists(relativePath) {
      return fs
        .access(absolute(relativePath))
        .then(() => true)
        .catch(() => false);
    },

    async cleanup() {
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
}
