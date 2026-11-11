#!/usr/bin/env node
/**
 * 大肥鱼 MCP Server
 * ------------------------------------------------------------------
 * 将「大肥鱼大屏」内置的文件服务 (http://127.0.0.1:18901) 封装为
 * 标准 Model Context Protocol (MCP) 工具，参考 awslabs/mcp 的服务
 * 组织方式：一个轻量进程 + 一组带 JSON Schema 的工具 + 清晰的错误返回。
 * 另内置浏览器工具（playwright-core + 系统 Edge/Chrome）：
 *   browser_open / browser_search / browser_screenshot / browser_close
 *   环境变量：DAFY_BROWSER_PATH 指定浏览器，DAFY_BROWSER_HEADLESS=0 可显示窗口
 * 本地文件管理：create_directory / delete_path（基于资源库根目录，含路径逃逸防护）
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
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

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

// ---- 内置浏览器（playwright-core + 系统 Edge/Chrome，无需下载内核） ----
const BROWSER_CANDIDATES = [
  process.env.DAFY_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findBrowserExe() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

let browser = null;
let context = null;

async function getContext() {
  if (browser && browser.isConnected()) {
    if (!context) context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    return context;
  }
  const exe = findBrowserExe();
  if (!exe) {
    throw new Error(
      "未找到 Edge/Chrome 可执行文件。请安装 Microsoft Edge，或用环境变量 DAFY_BROWSER_PATH 指定浏览器路径。"
    );
  }
  browser = await chromium.launch({
    executablePath: exe,
    headless: process.env.DAFY_BROWSER_HEADLESS !== "0",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    locale: "zh-CN",
  });
  return context;
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch (e) {}
  browser = null;
  context = null;
}

function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) throw new Error("url 不能为空");
  if (/^https?:\/\//i.test(s)) return s;
  return "https://" + s;
}

async function openPage(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    const title = await page.title();
    const finalUrl = page.url();
    const text = await page.evaluate(() =>
      document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n").trim() : ""
    );
    return { page, title, finalUrl, text };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

// ---- 本地文件管理（读写根目录由大屏文件服务提供，防路径逃逸） ----
async function getLibraryRoot() {
  const j = await fsGet("/api/root");
  if (!j.root) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "资源库未设置，请先在大屏中点击「📂 选择文件夹」。"
    );
  }
  return j.root;
}

function resolveInside(root, rel) {
  const target = path.resolve(root, String(rel || ""));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new McpError(ErrorCode.InvalidParams, "路径越界：只能操作资源库内的文件");
  }
  return target;
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
    name: "create_directory",
    description:
      "在资源库中新建文件夹（自动创建多层父目录）。已存在时不报错，直接返回成功。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于资源库根目录的文件夹路径，例如 'AI产出/2026-11'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_path",
    description:
      "删除资源库中的文件或文件夹。删除非空文件夹必须显式传 recursive=true，防止误删。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于资源库根目录的路径，例如 'AI产出/旧笔记.md'",
        },
        recursive: {
          type: "boolean",
          description: "是否递归删除文件夹内的全部内容，默认 false",
          default: false,
        },
      },
      required: ["path"],
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
  {
    name: "browser_open",
    description:
      "用内置浏览器（系统 Edge/Chrome）打开任意网址，返回页面标题、最终 URL 和正文文本。适合查网页、看文档、读新闻。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要打开的网址，可省略 https://，例如 'www.baidu.com'",
        },
        maxChars: {
          type: "number",
          description: "返回正文的最大字符数，默认 4000",
          default: 4000,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_search",
    description:
      "用内置浏览器在必应/百度搜索关键词，返回前几条结果的标题、链接和摘要。适合需要联网查资料时使用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        engine: {
          type: "string",
          description: "搜索引擎：bing（默认）或 baidu",
          enum: ["bing", "baidu"],
          default: "bing",
        },
        limit: {
          type: "number",
          description: "返回结果条数，默认 8",
          default: 8,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "用内置浏览器打开网址并截图，返回 PNG 图片。适合查看页面外观、图表或无法用文字描述的内容。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要截图的网址" },
        fullPage: {
          type: "boolean",
          description: "是否整页截图，默认 false（只截可视区域）",
          default: false,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_close",
    description: "关闭内置浏览器进程，释放内存。",
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

      case "create_directory": {
        const rel = (args.path || "").toString().trim();
        if (!rel) {
          throw new McpError(ErrorCode.InvalidParams, "path 参数不能为空");
        }
        const root = await getLibraryRoot();
        const target = resolveInside(root, rel);
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isDirectory()) {
            return {
              content: [{ type: "text", text: `已存在同名文件，未创建文件夹: ${rel}` }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: `文件夹已存在: ${rel}` }] };
        }
        fs.mkdirSync(target, { recursive: true });
        return { content: [{ type: "text", text: `已创建文件夹: ${rel}` }] };
      }

      case "delete_path": {
        const rel = (args.path || "").toString().trim();
        if (!rel) {
          throw new McpError(ErrorCode.InvalidParams, "path 参数不能为空");
        }
        const root = await getLibraryRoot();
        const target = resolveInside(root, rel);
        if (path.resolve(target) === path.resolve(root)) {
          throw new McpError(ErrorCode.InvalidParams, "不能删除资源库根目录");
        }
        if (!fs.existsSync(target)) {
          return {
            content: [{ type: "text", text: `路径不存在: ${rel}` }],
            isError: true,
          };
        }
        const st = fs.statSync(target);
        if (st.isDirectory()) {
          const count = fs.readdirSync(target).length;
          if (count > 0 && !args.recursive) {
            return {
              content: [
                {
                  type: "text",
                  text: `文件夹非空（${count} 项）。如确认整体删除，请传 recursive=true。`,
                },
              ],
              isError: true,
            };
          }
          fs.rmSync(target, { recursive: !!args.recursive, force: true });
          return { content: [{ type: "text", text: `已删除文件夹: ${rel}` }] };
        }
        fs.rmSync(target, { force: true });
        return {
          content: [
            { type: "text", text: `已删除文件: ${rel} (${humanSize(st.size)})` },
          ],
        };
      }

      case "browser_open": {
        const maxChars = Number(args.maxChars) > 0 ? Math.min(Number(args.maxChars), 20000) : 4000;
        const { page, title, finalUrl, text } = await openPage(args.url);
        await page.close().catch(() => {});
        const body =
          text.length > maxChars ? text.slice(0, maxChars) + "\n…（已截断）" : text;
        return {
          content: [
            {
              type: "text",
              text: `标题: ${title}\n地址: ${finalUrl}\n\n${body || "（页面无正文）"}`,
            },
          ],
        };
      }

      case "browser_search": {
        const q = String(args.query || "").trim();
        if (!q) throw new McpError(ErrorCode.InvalidParams, "query 参数不能为空");
        const engine = args.engine === "baidu" ? "baidu" : "bing";
        const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 20) : 8;
        const target =
          engine === "baidu"
            ? `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`
            : `https://cn.bing.com/search?q=${encodeURIComponent(q)}`;
        const { page } = await openPage(target);
        const extract = () =>
          page.evaluate((lim) => {
          const out = [];
          const nodes = document.querySelectorAll(
            "#b_results > li.b_algo, #content_left div.result, #content_left div.result-op, div.c-container"
          );
          nodes.forEach((el) => {
            const a = el.querySelector("h2 a, h3 a");
            if (!a || !a.href) return;
            const sn = el.querySelector(
              ".b_caption p, .b_algoSlug, .c-abstract, .content-right_8Zs40, .c-span-last"
            );
            const title = (a.innerText || "").trim();
            if (!title) return;
            if (out.some((x) => x.url === a.href)) return;
            out.push({
              title,
              url: a.href,
              snippet: sn ? sn.innerText.trim().slice(0, 200) : "",
            });
          });
          return out.slice(0, lim);
          }, limit);
        await page
          .waitForSelector("#b_results > li.b_algo, #content_left div.result", { timeout: 8000 })
          .catch(() => {});
        let results = await extract();
        if (!results.length) {
          await page.waitForTimeout(1500);
          results = await extract();
        }
        await page.close().catch(() => {});
        if (!results.length) {
          return {
            content: [
              {
                type: "text",
                text: `未从 ${engine} 解析到结果（可能被验证码/改版拦截），可改用 browser_open 直接打开搜索页。`,
              },
            ],
            isError: true,
          };
        }
        const txt = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}`)
          .join("\n\n");
        return { content: [{ type: "text", text: `搜索「${q}」（${engine}）:\n\n${txt}` }] };
      }

      case "browser_screenshot": {
        const { page, title, finalUrl } = await openPage(args.url);
        const buf = await page.screenshot({ fullPage: !!args.fullPage, type: "png" });
        await page.close().catch(() => {});
        return {
          content: [
            {
              type: "text",
              text: `截图: ${title} (${finalUrl}, ${Math.round(buf.length / 1024)} KB)`,
            },
            { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
          ],
        };
      }

      case "browser_close": {
        await closeBrowser();
        return { content: [{ type: "text", text: "内置浏览器已关闭" }] };
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

// ---- 退出时清理浏览器 ----
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
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
