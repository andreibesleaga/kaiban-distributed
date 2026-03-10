import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    console.log(
      `[MCP] Connecting to server: ${this.serverCommand} ${this.serverArgs.join(" ")}`,
    );
    this.transport = new StdioClientTransport({
      command: this.serverCommand,
      args: this.serverArgs,
    });
    await this.client.connect(this.transport);
    console.log("[MCP] Connected successfully");
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
      console.log("[MCP] Disconnected");
    }
  }
}
