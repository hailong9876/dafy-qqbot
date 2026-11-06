/**
 * 快速自检：用 MCP Client 连接本地 dafy-mcp server，列出工具并调用 ping。
 * 用法: node test-client.js
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
const client = new Client({ name: "dafy-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
});

await client.connect(transport);

// 1) initialize 已由 SDK 自动完成
console.log("✓ MCP 握手成功");

// 2) 列出工具
const tools = await client.listTools();
console.log("\n可用工具:");
tools.tools.forEach((t) => {
  console.log(`  • ${t.name} — ${t.description}`);
});

// 3) 调用 ping
console.log("\n调用 ping:");
try {
  const r = await client.callTool({ name: "ping", arguments: {} });
  console.log("  →", r.content.map((c) => c.text || `[${c.type}]`).join(" "));
} catch (e) {
  console.log("  ✗", e.message);
}

// 4) 调用 list_directory（文件服务可能未启动，仅验证协议链路）
console.log("\n调用 list_directory:");
try {
  const r = await client.callTool({
    name: "list_directory",
    arguments: { path: "" },
  });
  const txt = r.content.map((c) => c.text || `[${c.type}]`).join("\n");
  console.log("  →", txt.slice(0, 300));
} catch (e) {
  console.log("  ✗", e.message);
}

await client.close();
console.log("\n✓ 测试完成");
