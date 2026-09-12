/**
 * 功能概述：检查 VitePress 构建产物中的站内链接、锚点与 HTML/CSS 静态资源。
 * 主要职责：checkLinks 接收产物目录和部署 base，解析生成文件中的 href、src、poster
 * 及 CSS url()，按 clean URL 和目录首页规则寻找目标；缺页、缺资源、缺锚点或归档
 * 路径残留时抛错。walk 递归列出文件，decodeEntities 还原生成 HTML 中的属性值。
 * 代码库关系：docs:check 在构建成功后运行本文件，CLI 通过 VitePress resolveConfig
 * 读取实际 outDir/base；导出的检查函数也用于 Node 内置测试，不加载站点配置。
 * 输入输出与副作用：只读取构建目录，不发起外网请求、不修改文件；返回页面与引用
 * 计数。CLI 汇总失败信息并设置非零退出码，供 PR 和 Pages 发布工作流阻断坏链接。
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const legacyPaths = [
  "zh/",
  "ours/",
  "superpowers/",
  "avatars/",
  "title_img/",
  "installation-agent.md",
  "_redirects",
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : path;
      }),
    )
  ).flat();
}

function decodeEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, key) =>
    key.startsWith("#")
      ? String.fromCodePoint(
          key[1].toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1)),
        )
      : named[key.toLowerCase()],
  );
}

export async function checkLinks(outDir, base) {
  const files = new Map(
    (await walk(outDir)).map((path) => [
      relative(outDir, path).split(sep).join("/"),
      path,
    ]),
  );
  const errors = [];
  const contents = new Map();
  const anchors = new Map();
  const origin = "https://documentation.invalid";
  let references = 0;
  for (const [name, path] of files) {
    if (legacyPaths.some((legacy) => name.startsWith(legacy))) {
      errors.push(`${name}: 归档内容不应出现在构建产物中`);
    }
    if (![".html", ".css", ".svg"].includes(extname(name))) continue;
    const content = await readFile(path, "utf8");
    contents.set(name, content);
    anchors.set(
      name,
      new Set(
        [...content.matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)].map((match) =>
          decodeEntities(match[2]),
        ),
      ),
    );
  }
  const pages = [...files.keys()].filter((name) => name.endsWith(".html"));
  if (!pages.includes("index.html")) errors.push("缺少构建后的 index.html");

  for (const [name, content] of contents) {
    const urls = [];
    if (name.endsWith(".html") || name.endsWith(".svg")) {
      // 只提取真实标签，排除注释和内联脚本正文中的示例字符串。
      const markup = content
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1</script>");
      for (const tag of markup.matchAll(/<[a-z][^>]*>/gi)) {
        for (const attribute of tag[0].matchAll(
          /\s(?:href|src|poster)\s*=\s*(["'])(.*?)\1/gi,
        )) {
          urls.push(decodeEntities(attribute[2]));
        }
      }
    }
    if (name.endsWith(".css")) {
      for (const match of content.matchAll(
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,
      )) {
        urls.push(match[1] ?? match[2] ?? match[3]);
      }
    }
    for (const value of urls) {
      if (!value || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) continue;
      references++;
      try {
        const url = new URL(value, `${origin}${base}${name}`);
        if (!url.pathname.startsWith(base)) {
          throw new Error(`链接越出部署路径 ${base}`);
        }
        const target = decodeURIComponent(url.pathname.slice(base.length));
        const candidates = [target];
        if (target.endsWith("/") || target === "") {
          candidates.push(`${target}index.html`);
        } else if (!extname(target)) {
          candidates.push(`${target}.html`, `${target}/index.html`);
        }
        const found = candidates.find((candidate) => files.has(candidate));
        if (!found) throw new Error("目标文件不存在");
        const anchor = decodeURIComponent(url.hash.slice(1));
        if (anchor && anchors.has(found) && !anchors.get(found).has(anchor)) {
          throw new Error(`目标锚点不存在：${anchor}`);
        }
      } catch (error) {
        errors.push(`${name} → ${value}: ${error.message}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { pages: pages.length, references };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { resolveConfig } = await import("vitepress");
    const config = await resolveConfig(
      fileURLToPath(new URL("..", import.meta.url)),
      "build",
    );
    const result = await checkLinks(config.outDir, config.site.base);
    console.log(
      `文档链接检查通过：${result.pages} 个页面，${result.references} 个站内引用。`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
