export interface McpHttpFixture {
  origin: string;
  requests: string[];
  tokenRequests: string[];
  hang(): void;
  discovered(): Promise<void>;
  close(): Promise<void>;
}
export function startMcpHttpFixture(): Promise<McpHttpFixture>;
