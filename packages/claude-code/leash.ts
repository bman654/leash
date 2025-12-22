#!/usr/bin/env node
import { homedir } from "os";
import { existsSync } from "fs";
import { CommandAnalyzer, getAdditionalDirectories } from "../core/index.js";

/** Secret temporary unblock file - when present, all checks are bypassed */
const UNBLOCK_FILE = "/tmp/dunblock";

/**
 * Parse CLI arguments as additional working directories.
 * Expands ~ to home directory. Only absolute paths are accepted;
 * relative paths emit a warning to stderr.
 *
 * @returns Array of absolute directory paths from CLI args
 */
function parseCliDirectories(): string[] {
  // Skip node and script path
  const args = process.argv.slice(2);
  const directories: string[] = [];

  for (const arg of args) {
    // Expand ~ to home directory
    const expanded = arg.replace(/^~(?=\/|$)/, homedir());

    // Only accept absolute paths
    if (expanded.startsWith("/")) {
      directories.push(expanded);
    } else {
      console.error(`Warning: Relative path "${arg}" ignored. Only absolute paths are accepted.`);
    }
  }

  return directories;
}

interface ClaudeCodeHookInput {
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
  };
  cwd: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let input: ClaudeCodeHookInput;

  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    console.error("Failed to parse input JSON");
    process.exit(1);
  }

  const { tool_name, tool_input, cwd } = input;

  // Check for temporary unblock file - bypass all checks if present
  if (existsSync(UNBLOCK_FILE)) {
    process.exit(0);
  }

  // Get project directory from environment variable (set by Claude Code)
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  // Build list of allowed working directories
  const directories: string[] = [cwd];

  // Add project directory if available and different from cwd
  if (projectDir && projectDir !== cwd) {
    directories.push(projectDir);
  }

  // Add additional directories from project settings
  if (projectDir) {
    const additionalDirs = getAdditionalDirectories(projectDir);
    directories.push(...additionalDirs);
  }

  // Add CLI-specified directories
  const cliDirectories = parseCliDirectories();
  directories.push(...cliDirectories);

  const analyzer = new CommandAnalyzer(directories);

  // Format directories for error messages
  const projectDisplay = projectDir ? `Project directory: ${projectDir}` : "Project directory: (not set)";
  const dirsDisplay =
    directories.length === 1
      ? `Allowed directory: ${directories[0]}`
      : `Allowed directories:\n  - ${directories.join("\n  - ")}`;

  // Shell command execution
  if (tool_name === "Bash") {
    const command = tool_input.command || "";
    const result = analyzer.analyze(command);

    if (result.blocked) {
      console.error(
        `🚫 Command blocked: ${command}\n` +
          `Reason: ${result.reason}\n` +
          `${projectDisplay}\n` +
          `${dirsDisplay}\n` +
          `Action: Guide the user to run the command manually.`
      );
      process.exit(2);
    }
  }

  // File write/edit operations
  if (tool_name === "Write" || tool_name === "Edit") {
    const path = tool_input.file_path || "";
    const result = analyzer.validatePath(path);

    if (result.blocked) {
      console.error(
        `🚫 File operation blocked: ${path}\n` +
          `Reason: ${result.reason}\n` +
          `${projectDisplay}\n` +
          `${dirsDisplay}\n` +
          `Action: Guide the user to perform this operation manually.`
      );
      process.exit(2);
    }
  }

  // Allow operation
  process.exit(0);
}

main();
