import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cwd } from "node:process";
import { runInSandbox, runFileInSandbox } from "./sandbox.js";
import { indexContent, searchKnowledge } from "./knowledge.js";
import { fetchAndConvert } from "./fetcher.js";
import { getRecentEvents } from "./session.js";

const PROJECT_PATH = cwd();

const TOOLS: Tool[] = [
  {
    name: "zc_execute",
    description:
      "Run code in a secure isolated sandbox. No credentials are available inside the sandbox. " +
      "Supports: python, javascript, bash. Hard limits: 30s timeout, 512KB stdout.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "python3", "javascript", "js", "bash", "sh"],
          description: "Programming language to execute",
        },
        code: {
          type: "string",
          description: "Code to execute",
        },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "zc_execute_file",
    description:
      "Run analysis code against a specific file path in the sandbox. " +
      "The file path is injected as TARGET_FILE variable in the analysis code.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to analyze",
        },
        language: {
          type: "string",
          enum: ["python", "python3"],
          description: "Language of the analysis code (python only)",
        },
        code: {
          type: "string",
          description: "Analysis code. Use TARGET_FILE variable for the file path.",
        },
      },
      required: ["path", "language", "code"],
    },
  },
  {
    name: "zc_fetch",
    description:
      "Fetch a URL, convert to markdown, and index into the session knowledge base. " +
      "Credential headers (Authorization, Cookie, X-Api-Key) are stripped automatically.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch (http/https only)",
        },
        source: {
          type: "string",
          description: "Optional label for this knowledge entry (defaults to URL)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "zc_index",
    description:
      "Manually index text content into the session knowledge base for later search.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Text content to index",
        },
        source: {
          type: "string",
          description: "Label/identifier for this content entry",
        },
      },
      required: ["content", "source"],
    },
  },
  {
    name: "zc_search",
    description:
      "Full-text BM25 search across the session knowledge base. " +
      "Pass multiple queries to search for several topics at once.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "One or more search queries",
          minItems: 1,
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "zc_batch",
    description:
      "Execute shell commands in sandbox AND search the knowledge base in a single call. " +
      "Ideal for research tasks: run commands to gather data while searching existing knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Human-readable label for this command" },
              command: { type: "string", description: "Shell command to run" },
            },
            required: ["label", "command"],
          },
          description: "List of labeled bash commands to run in sandbox",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Knowledge base search queries",
        },
      },
      required: ["commands", "queries"],
    },
  },
];

const server = new Server(
  { name: "zc-ctx", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "zc_execute": {
        const { language, code } = args as { language: string; code: string };
        const result = await runInSandbox(language, code);
        return {
          content: [
            {
              type: "text",
              text: formatSandboxResult(result),
            },
          ],
        };
      }

      case "zc_execute_file": {
        const { path, language, code } = args as {
          path: string;
          language: string;
          code: string;
        };
        const result = await runFileInSandbox(path, language, code);
        return {
          content: [{ type: "text", text: formatSandboxResult(result) }],
        };
      }

      case "zc_fetch": {
        const { url, source } = args as { url: string; source?: string };
        const fetched = await fetchAndConvert(url);
        const label = source ?? fetched.title ?? url;
        indexContent(PROJECT_PATH, fetched.markdown, label);
        return {
          content: [
            {
              type: "text",
              text:
                `## Fetched: ${fetched.title}\n` +
                `Source: ${fetched.url}\n` +
                `Size: ${(fetched.byteSize / 1024).toFixed(1)} KB\n` +
                `Indexed as: "${label}"\n\n` +
                fetched.markdown.slice(0, 8_000),
            },
          ],
        };
      }

      case "zc_index": {
        const { content, source } = args as { content: string; source: string };
        indexContent(PROJECT_PATH, content, source);
        return {
          content: [{ type: "text", text: `Indexed "${source}" (${content.length} chars)` }],
        };
      }

      case "zc_search": {
        const { queries } = args as { queries: string[] };
        const results = searchKnowledge(PROJECT_PATH, queries);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found in knowledge base." }],
          };
        }
        const formatted = results
          .map(
            (r, i) =>
              `### Result ${i + 1}: ${r.source}\n` +
              `Rank: ${r.rank.toFixed(4)}\n\n` +
              r.snippet
          )
          .join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "zc_batch": {
        const { commands, queries } = args as {
          commands: Array<{ label: string; command: string }>;
          queries: string[];
        };

        // Run all commands in parallel (each in isolated sandbox)
        const [commandResults, searchResults] = await Promise.all([
          Promise.all(
            commands.map(async ({ label, command }) => {
              const result = await runInSandbox("bash", command);
              return { label, result };
            })
          ),
          Promise.resolve(searchKnowledge(PROJECT_PATH, queries)),
        ]);

        const sections: string[] = [];

        for (const { label, result } of commandResults) {
          sections.push(
            `## ${label}\n\n` +
            "```\n" + formatSandboxResult(result) + "\n```"
          );
        }

        if (searchResults.length > 0) {
          sections.push("## Knowledge Base Results");
          for (const r of searchResults) {
            sections.push(`### ${r.source}\n${r.snippet}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

function formatSandboxResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (result.timedOut) parts.push("[TIMED OUT after 30s]");
  if (result.truncated) parts.push("[OUTPUT TRUNCATED]");
  if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
  parts.push(`Exit code: ${result.exitCode ?? "killed"}`);
  return parts.join("\n\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
