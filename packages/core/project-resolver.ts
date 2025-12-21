/**
 * Project Directory Utilities for Claude Code
 *
 * Reads additional working directories from project settings.
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

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
