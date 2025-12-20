#!/usr/bin/env node
import { CommandAnalyzer, resolveWorkingDirectories } from "../core/index.js";

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
  const analyzer = new CommandAnalyzer(workingDirectories);

  // Format directories for error messages
  const dirsDisplay =
    workingDirectories.length === 1
      ? `Working directory: ${workingDirectories[0]}`
      : `Working directories:\n  - ${workingDirectories.join("\n  - ")}`;

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
