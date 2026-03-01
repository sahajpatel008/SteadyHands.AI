import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { logMain } from "../../shared/logger";
import type {
  McpToolCall,
  McpToolCallResult,
  McpToolDescriptor,
} from "../../shared/types";
import type { McpServerConfig } from "./config";

type ConnectedServer = {
  client: Client;
  transport: { close: () => Promise<void> };
  toolsCache: { expiresAt: number; tools: McpToolDescriptor[] } | null;
};

const TOOL_CACHE_TTL_MS = 10000;

function mergeEnv(overrides?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return {
    ...base,
    ...(overrides ?? {}),
  };
}

function summarizeToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "Tool returned no structured content.";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typed = item as {
      type?: string;
      text?: string;
      mimeType?: string;
      resource?: { uri?: string };
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
      continue;
    }
    if (typed.type === "resource" && typed.resource?.uri) {
      parts.push(`Resource: ${typed.resource.uri}`);
      continue;
    }
    if (typed.type === "image" || typed.type === "audio") {
      parts.push(`${typed.type}(${typed.mimeType ?? "unknown"})`);
    }
  }

  if (parts.length === 0) {
    return "Tool returned non-text content.";
  }
  const joined = parts.join("\n").trim();
  return joined.length > 5000 ? `${joined.slice(0, 5000)}...` : joined;
}

export class McpClientManager {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly connections = new Map<string, ConnectedServer>();

  constructor(servers: Record<string, McpServerConfig>) {
    this.servers = servers;
  }

  private getServerConfig(server: string): McpServerConfig {
    const config = this.servers[server];
    if (!config || config.disabled) {
      throw new Error(`MCP server "${server}" is not configured or disabled.`);
    }
    return config;
  }

  private async connect(server: string): Promise<ConnectedServer> {
    const existing = this.connections.get(server);
    if (existing) return existing;

    const serverConfig = this.getServerConfig(server);
    const client = new Client({
      name: `steadyhands-mcp-${server}`,
      version: "0.1.0",
    });
    let transport: { close: () => Promise<void> };

    if (serverConfig.transport === "http") {
      if (!serverConfig.url) {
        throw new Error(`MCP server "${server}" missing url for http transport.`);
      }
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url));
    } else {
      if (!serverConfig.command) {
        throw new Error(`MCP server "${server}" missing command for stdio transport.`);
      }
      const stdioTransport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        cwd: serverConfig.cwd,
        env: mergeEnv(serverConfig.env),
        stderr: "pipe",
      });
      const stderr = stdioTransport.stderr;
      if (stderr) {
        stderr.on("data", (chunk) => {
          const message = String(chunk).trim();
          if (message) {
            logMain("mcp", `stderr:${server}`, message.slice(0, 400));
          }
        });
      }
      transport = stdioTransport;
    }

    client.onerror = (error) => {
      logMain("mcp", `client error:${server}`, { error: String(error) });
    };

    await client.connect(transport);
    logMain("mcp", "Connected server", { server });

    const connected: ConnectedServer = {
      client,
      transport,
      toolsCache: null,
    };
    this.connections.set(server, connected);
    return connected;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const serverNames = Object.entries(this.servers)
      .filter(([, cfg]) => !cfg.disabled)
      .map(([name]) => name);

    if (serverNames.length === 0) {
      return [];
    }

    const out: McpToolDescriptor[] = [];
    for (const server of serverNames) {
      try {
        const connection = await this.connect(server);
        const now = Date.now();
        if (connection.toolsCache && connection.toolsCache.expiresAt > now) {
          out.push(...connection.toolsCache.tools);
          continue;
        }

        const listed = await connection.client.listTools();
        const mapped: McpToolDescriptor[] = listed.tools.map((tool) => ({
          server,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));
        connection.toolsCache = {
          expiresAt: now + TOOL_CACHE_TTL_MS,
          tools: mapped,
        };
        out.push(...mapped);
      } catch (error) {
        logMain("mcp", "listTools failed", {
          server,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  async callTool(call: McpToolCall): Promise<McpToolCallResult> {
    const connection = await this.connect(call.server);
    const response = await connection.client.callTool({
      name: call.name,
      arguments: call.arguments ?? {},
    });

    return {
      ok: !response.isError,
      server: call.server,
      name: call.name,
      content: summarizeToolContent(response.content),
      isError: response.isError,
    };
  }

  async closeAll(): Promise<void> {
    const closing = Array.from(this.connections.entries()).map(
      async ([server, connection]) => {
        try {
          await connection.transport.close();
          logMain("mcp", "Closed server transport", { server });
        } catch (error) {
          logMain("mcp", "Failed closing server transport", {
            server,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    await Promise.allSettled(closing);
    this.connections.clear();
  }
}
