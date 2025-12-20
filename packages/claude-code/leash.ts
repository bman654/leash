#!/usr/bin/env node
import { homedir } from "os";
import { CommandAnalyzer, resolveWorkingDirectories } from "../core/index.js";

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
  transcript_path?: string;
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

  const { tool_name, tool_input, cwd, transcript_path } = input;

  // Resolve all working directories (cwd + additional from project settings)
  const workingDirectories = resolveWorkingDirectories(cwd, transcript_path);

  // Add CLI-specified directories
  const cliDirectories = parseCliDirectories();

  // Merge all directories
  const allDirectories = [...workingDirectories, ...cliDirectories];
  const analyzer = new CommandAnalyzer(allDirectories);

  // Format directories for error messages
  const dirsDisplay =
    allDirectories.length === 1
      ? `Working directory: ${allDirectories[0]}`
      : `Working directories:\n  - ${allDirectories.join("\n  - ")}`;

  // Shell command execution
  if (tool_name === "Bash") {
    const command = tool_input.command || "";
    const result = analyzer.analyze(command);

    if (result.blocked) {
      console.error(
        `🚫 Command blocked: ${command}\n` +
          `Reason: ${result.reason}\n` +
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
