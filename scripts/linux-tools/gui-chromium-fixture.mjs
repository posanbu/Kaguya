/**
 * 功能概述：应用 UID 的可见 Chromium 合成页面，用实际页面事件独立记录 GUI 输入结果。
 * 主要职责：固定启动 sandbox Chromium 和本容器 HTTP 服务；ready 与串行 ledger 均完整写入后原子发布。
 * 代码库关系：check-gui-container.py 固定以 UID1001 启动；gui-chromium-probe.mjs 通过 Cua 输入。
 * 输入输出与副作用：不开放 CDP、不执行页面自动化；记录 uid/pid/text/count，终止时回收自身浏览器。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { publishFixtureJson } from "./gui-fixture-json.mjs";
import { chromium } from "/opt/kaguya-browser/node_modules/playwright/index.mjs";
if (process.getuid() !== 1001) throw new Error("gui-app-uid-required");
const root = "/home/app/session";
await mkdir(`${root}/chromium-profile`, { mode: 0o700, recursive: true });
let browser;
let chain = Promise.resolve();
let current = { uid: 1001, pid: 0, text: "", count: 0 };
async function save() {
  await publishFixtureJson(`${root}/chromium-ledger.json`, current);
}

const html = `<!doctype html><meta charset="utf-8"><title>Kaguya Chromium acceptance</title>
<style>body{font:24px sans-serif;padding:48px}input,button{font:inherit;margin:12px;padding:12px}</style>
<h1>Kaguya Chromium acceptance</h1><label>Browser unsaved text<input aria-label="Browser unsaved text"></label>
<button>Browser increment once</button><p id="count">Count: 0</p><p id="value">Value: </p><script>
let count=0, chain=Promise.resolve(); const input=document.querySelector('input');
function save(){document.querySelector('#value').textContent='Value: '+input.value;const body=JSON.stringify({text:input.value,count});chain=chain.then(()=>fetch('/event',{method:'POST',body}));}
input.addEventListener('input',save);document.querySelector('button').addEventListener('click',()=>{count++;document.querySelector('#count').textContent='Count: '+count;save();});
</script>`;
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/event") {
    response.writeHead(404).end();
    return;
  }
  try {
    let raw = "";
    for await (const data of request) {
      raw += data;
      if (raw.length > 4096) throw new Error("fixture-event-limit");
    }
    const event = JSON.parse(raw);
    if (
      typeof event.text !== "string" ||
      !Number.isSafeInteger(event.count) ||
      event.count < 0
    )
      throw new Error("fixture-event-invalid");
    chain = chain.then(async () => {
      current = {
        uid: 1001,
        pid: browser.pid,
        text: event.text,
        count: event.count,
      };
      await save();
    });
    await chain;
    response.writeHead(204).end();
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const log = openSync(`${root}/chromium.log`, "a", 0o600);
browser = spawn(
  chromium.executablePath(),
  [
    `--user-data-dir=${root}/chromium-profile`,
    "--force-renderer-accessibility",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--password-store=basic",
    url,
  ],
  {
    stdio: ["ignore", log, log],
    env: { ...process.env, HOME: root, DISPLAY: ":99" },
  },
);
closeSync(log);
browser.once("error", (error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
browser.once("exit", (code) => {
  server.close();
  process.exitCode = code || 1;
});
current.pid = browser.pid;
await save();
await publishFixtureJson(`${root}/chromium-fixture.json`, {
  uid: 1001,
  pid: browser.pid,
  url,
});
process.once("SIGTERM", () => {
  browser.kill("SIGTERM");
  server.close();
});
