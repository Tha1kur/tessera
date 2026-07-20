import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ObjectStore } from "./objects/store.js";
import type { Identity } from "./objects/types.js";

/** The directory that marks a Tessera repository, like `.git` marks a Git one. */
export const REPOSITORY_DIRECTORY = ".tess";

export const DEFAULT_BRANCH = "main";

export const IGNORE_FILE = ".tessignore";

export class NotARepositoryError extends Error {
  constructor(startedFrom: string) {
    super(`not a Tessera repository (or any parent of ${startedFrom})`);
    this.name = "NotARepositoryError";
  }
}

export class RepositoryExistsError extends Error {
  constructor(public readonly at: string) {
    super(`a Tessera repository already exists at ${at}`);
    this.name = "RepositoryExistsError";
  }
}

export interface RepositoryConfig {
  /** On-disk format version, so future changes can migrate rather than crash. */
  formatVersion: number;
  user?: {
    name?: string;
    email?: string;
  };
}

const DEFAULT_CONFIG: RepositoryConfig = { formatVersion: 1 };

const DEFAULT_IGNORE = `# Paths Tessera should never track.
# One glob per line; a leading "!" re-includes a previously ignored path.

node_modules/
dist/
build/
coverage/
.DS_Store
*.log
.env
.env.*
`;

/**
 * A repository: the working directory you edit, plus the `.tess` directory
 * that remembers everything you have ever committed.
 *
 * This class owns *where things live*. It deliberately holds no history logic
 * of its own - the object store, the refs, the index and the commands each own
 * their own behaviour and take a Repository to find their files.
 */
export class Repository {
  readonly objects: ObjectStore;

  private constructor(
    /** Absolute path to the project root - the directory containing `.tess`. */
    readonly workingDirectory: string,
    /** Absolute path to the `.tess` directory itself. */
    readonly tesseraDirectory: string,
  ) {
    this.objects = new ObjectStore(path.join(tesseraDirectory, "objects"));
  }

  /* ---------------------------------------------------------------------- */
  /* Paths                                                                  */
  /* ---------------------------------------------------------------------- */

  /** A path inside `.tess`. */
  internal(...segments: string[]): string {
    return path.join(this.tesseraDirectory, ...segments);
  }

  /** Resolve a repo-relative path to an absolute one in the working tree. */
  absolute(relativePath: string): string {
    return path.resolve(this.workingDirectory, relativePath);
  }

  /**
   * Convert any path into a repo-relative, forward-slashed one.
   *
   * Normalising to forward slashes here is what lets a repository created on
   * Windows be read on Linux: the separator never reaches an object.
   *
   * Throws if the path escapes the working directory, which is the guard that
   * stops a malicious tree entry like `../../.ssh/authorized_keys` from being
   * written outside the project during a checkout.
   */
  relative(anyPath: string): string {
    const absolute = path.resolve(this.workingDirectory, anyPath);
    const relative = path.relative(this.workingDirectory, absolute);

    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`path escapes the repository: ${anyPath}`);
    }

    return relative.split(path.sep).join("/");
  }

  /** True if a path lies inside the `.tess` directory. */
  isInternal(anyPath: string): boolean {
    const absolute = path.resolve(this.workingDirectory, anyPath);
    return absolute === this.tesseraDirectory || absolute.startsWith(this.tesseraDirectory + path.sep);
  }

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                          */
  /* ---------------------------------------------------------------------- */

  async readConfig(): Promise<RepositoryConfig> {
    try {
      const raw = await fs.readFile(this.internal("config.json"), "utf8");
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as RepositoryConfig) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
      throw error;
    }
  }

  async writeConfig(config: RepositoryConfig): Promise<void> {
    await fs.writeFile(this.internal("config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /**
   * Who to record as the author of a commit. Repository config wins, then the
   * TESSERA_* environment variables, then a best guess from the machine.
   */
  async identity(at: Date = new Date()): Promise<Identity> {
    const config = await this.readConfig();

    const name = config.user?.name ?? process.env.TESSERA_AUTHOR_NAME ?? os.userInfo().username;
    const email =
      config.user?.email ?? process.env.TESSERA_AUTHOR_EMAIL ?? `${os.userInfo().username}@${os.hostname()}`;

    return {
      name,
      email,
      timestamp: at.getTime(),
      timezoneOffset: at.getTimezoneOffset(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Discovery and creation                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Walk up from `startPath` looking for a `.tess` directory, so commands work
   * from anywhere inside a project rather than only at its root.
   */
  static async discover(startPath: string = process.cwd()): Promise<Repository> {
    let current = path.resolve(startPath);

    for (;;) {
      const candidate = path.join(current, REPOSITORY_DIRECTORY);
      try {
        const stats = await fs.stat(candidate);
        if (stats.isDirectory()) return new Repository(current, candidate);
      } catch {
        // Not here; keep climbing.
      }

      const parent = path.dirname(current);
      if (parent === current) throw new NotARepositoryError(path.resolve(startPath));
      current = parent;
    }
  }

  /** Create a new repository, refusing to clobber an existing one. */
  static async initialise(at: string = process.cwd()): Promise<Repository> {
    const workingDirectory = path.resolve(at);
    const tesseraDirectory = path.join(workingDirectory, REPOSITORY_DIRECTORY);

    try {
      await fs.access(tesseraDirectory);
      throw new RepositoryExistsError(tesseraDirectory);
    } catch (error) {
      if (error instanceof RepositoryExistsError) throw error;
      // ENOENT is the happy path: there is nothing here yet.
    }

    await fs.mkdir(path.join(tesseraDirectory, "objects"), { recursive: true });
    await fs.mkdir(path.join(tesseraDirectory, "refs", "heads"), { recursive: true });

    const repository = new Repository(workingDirectory, tesseraDirectory);

    // HEAD points at a branch that does not exist yet. That is the correct
    // state for an empty repository: the branch is created by the first commit.
    await fs.writeFile(repository.internal("HEAD"), `ref: refs/heads/${DEFAULT_BRANCH}\n`, "utf8");
    await repository.writeConfig({ ...DEFAULT_CONFIG });

    const ignorePath = path.join(workingDirectory, IGNORE_FILE);
    try {
      await fs.writeFile(ignorePath, DEFAULT_IGNORE, { flag: "wx" });
    } catch {
      // An existing .tessignore belongs to the user; leave it alone.
    }

    return repository;
  }

  /** Attach to an existing repository at an exact path, without searching. */
  static async open(at: string): Promise<Repository> {
    const workingDirectory = path.resolve(at);
    const tesseraDirectory = path.join(workingDirectory, REPOSITORY_DIRECTORY);

    const stats = await fs.stat(tesseraDirectory).catch(() => null);
    if (!stats?.isDirectory()) throw new NotARepositoryError(workingDirectory);

    return new Repository(workingDirectory, tesseraDirectory);
  }
}
