import { resolve, relative } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";
import { SAFE_WRITE_PATHS, TEMP_PATHS } from "./constants.js";

export class PathValidator {
  private workingDirectories: string[];
  private primaryWorkingDirectory: string;

  /**
   * Create a PathValidator for one or more working directories.
   *
   * @param workingDirectories - Single directory or array of directories
   */
  constructor(workingDirectories: string | string[]) {
    // Normalize to array for uniform handling
    this.workingDirectories = Array.isArray(workingDirectories)
      ? workingDirectories
      : [workingDirectories];

    // Primary directory used for $PWD expansion and relative path resolution
    this.primaryWorkingDirectory = this.workingDirectories[0];
  }

  /** Expand ~ and environment variables in path */
  private expand(path: string): string {
    return path
      .replace(/^~(?=\/|$)/, homedir())
      .replace(/\$\{?(\w+)\}?/g, (_, name) => {
        if (name === "HOME") return homedir();
        if (name === "PWD") return this.primaryWorkingDirectory;
        return process.env[name] || "";
      });
  }

  /** Resolve path following all symlinks (including parent directories) */
  private resolveReal(path: string): string {
    const expanded = this.expand(path);
    const resolved = resolve(this.primaryWorkingDirectory, expanded);

    try {
      return realpathSync(resolved);
    } catch {
      // Path doesn't exist yet, use resolved path
      return resolved;
    }
  }

  /**
   * Check if a path is within any of the working directories.
   *
   * @param path - The path to check
   * @returns true if the path is within any working directory
   */
  isWithinWorkingDir(path: string): boolean {
    try {
      const realPath = this.resolveReal(path);

      // Check against each working directory
      for (const workDir of this.workingDirectories) {
        try {
          const realWorkDir = realpathSync(workDir);

          // Exact match
          if (realPath === realWorkDir) {
            return true;
          }

          // Check if path is a descendant
          const rel = relative(realWorkDir, realPath);
          if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
            return true;
          }
        } catch {
          // Directory doesn't exist - skip it
          continue;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private matchesAny(resolved: string, paths: string[]): boolean {
    return paths.some((p) => resolved === p || resolved.startsWith(p + "/"));
  }

  isSafeForWrite(path: string): boolean {
    const resolved = this.resolveReal(path);
    return this.matchesAny(resolved, SAFE_WRITE_PATHS);
  }

  isTempPath(path: string): boolean {
    const resolved = this.resolveReal(path);
    return this.matchesAny(resolved, TEMP_PATHS);
  }
}
