#!/usr/bin/env node
/**
 * 大肥鱼 MCP Server
 * ------------------------------------------------------------------
 * 将「大肥鱼大屏」内置的文件服务 (http://127.0.0.1:18901) 封装为
 * 标准 Model Context Protocol (MCP) 工具，参考 awslabs/mcp 的服务
 * 组织方式：一个轻量进程 + 一组带 JSON Schema 的工具 + 清晰的错误返回。
 *
 * 支持传输：stdio（默认，供 Claude Desktop / Cursor / Windsurf 等）
 * 用法：node server.js
 *       或在 MCP 客户端配置：
 *         "dafy": { "command": "node", "args": ["E:/ai/项目/大肥鱼/mcp-server/server.js"] }
 * ------------------------------------------------------------------
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

// ---- 文件服务地址（大肥鱼大屏.exe 内置） ----
const FS_HOST = process.env.DAFY_FS_HOST || "127.0.0.1";
const FS_PORT = parseInt(process.env.DAFY_FS_PORT || "18901", 10);
const FS_BASE = `http://${FS_HOST}:${FS_PORT}`;

/** 简易 GET，返回 JSON */
function fsGet(path) {
  return new Promise((resolve, reject) => {
    const url = FS_BASE + path;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("返回非 JSON: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("请求超时（文件服务可能未启动）"));
    });
  });
}

/** 简易 POST JSON，返回 JSON */
function fsPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: FS_HOST,
        port: FS_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("返回非 JSON: " + data.slice(0, 200)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("请求超时"));
    });
    req.write(payload);
    req.end();
  });
}

// ---- MCP Server ----
const server = new Server(
  {
    name: "dafy-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/** 工具清单（与文件服务 HTTP API 一一对应） */
const TOOLS = [
  {
    name: "list_directory",
    description:
      "列出大肥鱼资源库中指定目录的文件与子文件夹。path 留空表示根目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于资源库根目录的路径，留空为根目录",
          default: "",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "读取资源库中的文件内容。文本文件返回内容，图片返回 base64，二进制返回大小。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于资源库根目录的文件路径，例如 'AI产出/xxx.txt'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "将内容写入资源库中的文件（自动创建父目录）。适合保存 AI 产出的文本、代码、Markdown 等。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于资源库根目录的目标路径，例如 'AI产出/笔记.md'",
        },
        content: {
          type: "string",
          description: "要写入的文本内容",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "get_root",
    description: "获取当前资源库的根目录绝对路径。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ping",
    description: "检测大肥鱼文件服务是否在线。",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "ping": {
        await fsGet("/api/ping");
        return {
          content: [{ type: "text", text: "大肥鱼文件服务在线 ✓" }],
        };
      }

      case "get_root": {
        const j = await fsGet("/api/root");
        return {
          content: [
            {
              type: "text",
              text: j.root
                ? `资源库根目录: ${j.root}`
                : "尚未选择资源库文件夹，请在大屏中点击「📂 选择文件夹」。",
            },
          ],
        };
      }

      case "list_directory": {
        const rel = (args.path || "").toString();
        const j = await fsGet(
          `/api/list?path=${encodeURIComponent(rel)}`
        );
        if (j.needPick) {
          return {
            content: [
              {
                type: "text",
                text: "资源库未设置，请先在大屏中选择文件夹。",
              },
            ],
            isError: true,
          };
        }
        if (j.err) {
          return {
            content: [{ type: "text", text: "读取失败: " + j.err }],
            isError: true,
          };
        }
        const dirs = (j.dirs || [])
          .map((d) => `📁 ${d.n}${d.m ? "  (" + d.m + ")" : ""}`)
          .join("\n");
        const files = (j.files || [])
          .map(
            (f) =>
              `📄 ${f.n}  ${
                f.s != null ? humanSize(f.s) : ""
              }`
          )
          .join("\n");
        const head = `目录: /${j.path || ""}\n`;
        const body = [dirs, files].filter(Boolean).join("\n");
        return {
          content: [
            {
              type: "text",
              text: head + (body || "（空文件夹）"),
            },
          ],
        };
      }

      case "read_file": {
        const rel = (args.path || "").toString();
        if (!rel) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "path 参数不能为空"
          );
        }
        const j = await fsGet(
          `/api/read?path=${encodeURIComponent(rel)}`
        );
        if (j.err) {
          return {
            content: [{ type: "text", text: "读取失败: " + j.err }],
            isError: true,
          };
        }
        if (j.kind === "image") {
          return {
            content: [
              {
                type: "text",
                text: `图片: ${j.name} (${j.mime}, ${humanSize(
                  j.size
                )})\n[base64 长度: ${j.data?.length || 0}]`,
              },
              {
                type: "image",
                data: j.data || "",
                mimeType: j.mime || "image/png",
              },
            ],
          };
        }
        if (j.kind === "bin") {
          return {
            content: [
              {
                type: "text",
                text: `二进制文件: ${j.name} (${humanSize(
                  j.size
                )})，暂不支持预览内容。`,
              },
            ],
          };
        }
        // 文本
        const text = (j.data || "") + (j.cut ? "\n\n…（内容过长已截断）" : "");
        return {
          content: [{ type: "text", text }],
        };
      }

      case "write_file": {
        const rel = (args.path || "").toString();
        const content = (args.content ?? "").toString();
        if (!rel) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "path 参数不能为空"
          );
        }
        const j = await fsPost("/api/write", {
          relPath: rel,
          content,
        });
        if (j.err) {
          return {
            content: [{ type: "text", text: "写入失败: " + j.err }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `已写入: ${rel}${j.size ? " (" + humanSize(j.size) + ")" : ""}`,
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `未知工具: ${name}`
        );
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    // 连接类错误 → 友好提示
    const msg = err?.message || String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("timeout") ||
      msg.includes("超时")
    ) {
      return {
        content: [
          {
            type: "text",
            text: `无法连接大肥鱼文件服务 (${FS_BASE})。\n请确认「大肥鱼大屏.exe」正在运行。\n原始错误: ${msg}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `工具执行出错: ${msg}` }],
      isError: true,
    };
  }
});

function humanSize(b) {
  if (b == null) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

// ---- 启动 stdio 传输 ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 仅在 stderr 输出日志（stdout 必须留给 MCP 协议）
  process.stderr.write(
    `[dafy-mcp] 已启动 · 文件服务 ${FS_BASE}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[dafy-mcp] 启动失败: ${err?.message || err}\n`);
  process.exit(1);
});
