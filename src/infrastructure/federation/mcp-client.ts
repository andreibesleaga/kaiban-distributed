import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "MCPClient" });

export class MCPFederationClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private serverCommand: string;
  private serverArgs: string[];

  constructor(serverCommand: string, serverArgs: string[] = []) {
    this.serverCommand = serverCommand;
    this.serverArgs = serverArgs;

    // Initialize MCP Client
    this.client = new Client(
      {
        name: "kaiban-federation-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
  }

  public async connect(): Promise<void> {
    log.info(
      { command: this.serverCommand, args: this.serverArgs },
      "Connecting to MCP server",
    );
    this.transport = new StdioClientTransport({
      command: this.serverCommand,
      args: this.serverArgs,
    });
    await this.client.connect(this.transport);
    log.info("Connected to MCP server");
  }

  public async listTools(): Promise<unknown> {
    return await this.client.listTools();
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.client.callTool({
      name,
      arguments: args,
    });
  }

  public async disconnect(): Promise<void> {
    if (this.transport) {
      await this.client.close();
      this.transport = null;
      log.info("Disconnected from MCP server");
    }
  }
}
