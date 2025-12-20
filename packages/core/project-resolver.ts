/**
 * Project Directory Resolver for Claude Code
 *
 * Resolves the project directory from Claude Code hook input by matching
 * the sanitized project name in transcript_path against ancestors of cwd.
 * Then reads additional working directories from project settings.
 */

import { dirname, basename, resolve } from "path";
import { readFileSync, existsSync } from "fs";

/**
 * Sanitize a path using Claude Code's pattern.
 * All non-alphanumeric characters become "-".
 *
 * @param path - The path to sanitize
 * @returns The sanitized path string
 *
 * @example
 * sanitizePath("/home/jan/src/bash-leash") // "-home-jan-src-bash-leash"
 * sanitizePath("/home/jan/.claude") // "-home-jan--claude"
 */
export function sanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Find the project directory by walking up from cwd and matching
 * against the sanitized project name extracted from transcript_path.
 *
 * @param cwd - Current working directory (may be project root or subdirectory)
 * @param transcriptPath - Full path to the transcript file
 * @returns The project directory path, or null if not found
 *
 * @example
 * // transcript_path: /home/jan/.claude/projects/-home-jan-src-bash-leash/session.jsonl
 * // cwd: /home/jan/src/bash-leash/packages/core
 * findProjectDirectory(cwd, transcriptPath) // "/home/jan/src/bash-leash"
 */
export function findProjectDirectory(
  cwd: string,
  transcriptPath: string
): string | null {
  // Extract sanitized project name from transcript path
  // Path structure: ~/.claude/projects/{sanitized-name}/{session-id}.jsonl
  const projectsDir = dirname(transcriptPath);
  const sanitizedName = basename(projectsDir);

  // Walk up from cwd toward root, checking each ancestor
  let current = resolve(cwd);

  while (current !== "/" && current.length > 1) {
    if (sanitizePath(current) === sanitizedName) {
      return current;
    }
    current = dirname(current);
  }

  // Check root as final attempt
  if (sanitizePath(current) === sanitizedName) {
    return current;
  }

  return null;
}

/**
 * Read additional directories from the project's local settings file.
 * Returns an empty array if the file doesn't exist or can't be parsed.
 *
 * @param projectDir - The project directory path
 * @returns Array of additional directory paths
 */
export function getAdditionalDirectories(projectDir: string): string[] {
  // Read from {project}/.claude/settings.local.json
  const settingsPath = resolve(projectDir, ".claude", "settings.local.json");

  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    // Extract permissions.additionalDirectories
    const dirs = settings?.permissions?.additionalDirectories;

    if (!Array.isArray(dirs)) {
      return [];
    }

    // Filter to only valid absolute path strings
    return dirs.filter(
      (d): d is string => typeof d === "string" && d.startsWith("/") && d.length > 1
    );
  } catch {
    // Silently fail - return empty array on any parse error
    return [];
  }
}

/**
 * Resolve all working directories for a Claude Code hook invocation.
 * Combines the primary cwd with the project directory and any additional
 * directories from project settings.
 *
 * @param cwd - The current working directory from hook input
 * @param transcriptPath - Optional transcript path for project resolution
 * @returns Array of all allowed working directories
 */
export function resolveWorkingDirectories(
  cwd: string,
  transcriptPath?: string
): string[] {
  // Always start with the primary cwd
  const directories = [cwd];

  // If no transcript path, can't resolve project directory
  if (!transcriptPath) {
    return directories;
  }

  // Find the project directory
  const projectDir = findProjectDirectory(cwd, transcriptPath);
  if (!projectDir) {
    return directories;
  }

  // Add project directory if cwd is a subdirectory of it
  // This allows commands targeting the project root when working in a subdir
  if (projectDir !== cwd) {
    directories.push(projectDir);
  }

  // Get additional directories from project settings
  const additional = getAdditionalDirectories(projectDir);

  return [...directories, ...additional];
}
