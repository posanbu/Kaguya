/**
 * 功能概述：验证文档发布门禁能够识别真实坏链接，同时接受合法的部署路径和资源。
 * 主要职责：fixture 在临时目录创建最小静态站，测试覆盖目录首页、clean URL、中文
 * 锚点、查询参数、相对 CSS 资源，以及缺页、缺锚点、缺资源和历史内容残留的失败。
 * 代码库关系：直接调用 check-links.mjs 的 checkLinks，由 Node 内置测试运行器执行。
 * 输入输出与副作用：只创建并自动清理临时文件，不访问网络或改动实际文档产物。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkLinks } from "./check-links.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-docs-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

test("支持部署 base、目录首页、clean URL、锚点及 HTML/CSS 资源", async (t) => {
  const root = await fixture(t, {
    "index.html":
      '<a href="/Kaguya/guide/">指南</a><a href="guide/topic?x=1&amp;y=2#%E9%85%8D%E7%BD%AE">配置</a><link href="assets/site.css"><script src="assets/site.js"></script><img src="images/logo.png"><a href="https://example.com/missing">外部</a>',
    "guide/index.html": '<a href="../">首页</a>',
    "guide/topic.html": '<h1 id="配置">配置</h1><a href="#配置">当前页</a>',
    "assets/site.css":
      'a { background: url("../images/logo.png"); } b { background: url(data:image/png;base64,AA==); }',
    "assets/site.js": "",
    "images/logo.png": "fixture",
  });
  assert.deepEqual(await checkLinks(root, "/Kaguya/"), {
    pages: 3,
    references: 8,
  });
});

for (const [name, files, message] of [
  [
    "缺失页面",
    { "index.html": '<a href="missing">坏链接</a>' },
    /目标文件不存在/,
  ],
  [
    "缺失锚点",
    { "index.html": '<a href="#missing">坏锚点</a>' },
    /目标锚点不存在/,
  ],
  ["缺失图片", { "index.html": '<img src="missing.png">' }, /目标文件不存在/],
  [
    "缺失 CSS 资源",
    {
      "index.html": "",
      "assets/site.css": "a { background: url(missing.png) }",
    },
    /目标文件不存在/,
  ],
  [
    "错误部署路径",
    { "index.html": '<a href="/guide/">坏前缀</a>' },
    /链接越出部署路径/,
  ],
  [
    "历史页面残留",
    { "index.html": "", "superpowers/plan.html": "" },
    /归档内容不应出现/,
  ],
  [
    "旧指南残留",
    { "index.html": "", "installation-agent.md": "" },
    /归档内容不应出现/,
  ],
  [
    "通配重写残留",
    { "index.html": "", _redirects: "/* /index.html 200" },
    /归档内容不应出现/,
  ],
  ["空产物", {}, /缺少构建后的 index.html/],
]) {
  test(`拒绝${name}`, async (t) => {
    const root = await fixture(t, files);
    await assert.rejects(checkLinks(root, "/Kaguya/"), message);
  });
}
