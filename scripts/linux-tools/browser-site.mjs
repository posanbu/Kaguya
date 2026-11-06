/**
 * 功能概述：CI 合成本机站点，独立于 Chromium 持久保存真实提交计数并提供固定下载、动态表单、选择控件和继承禁用的控件。
 * 代码库关系：browser_checks.py 经生产 Broker/helper 驱动页面，直接读取本 ledger 作 oracle。
 * 输入输出与副作用：只监听隔离容器 loopback，fsync 后原子替换 /private 计数与 ready 文件。
 */
import { createServer } from "node:http";
import { writeFile, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const root = "/private/browser-site";
const atomic = async (name, value) => {
  const path = root + "-" + name + ".json";
  await writeFile(path + ".tmp", JSON.stringify(value) + "\n");
  const file = await open(path + ".tmp", "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path + ".tmp", path);
  const dir = await open("/private", "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
};
let submissions = 0,
  pending = Promise.resolve();
const nonce = randomUUID();
let released = true;
const releaseWaiters = new Set();
const server = createServer(async (request, response) => {
  if (request.url === "/prepare") {
    released = false;
    await atomic("block", { entered: false });
    response.end("prepared");
  } else if (request.url === "/entered") {
    await atomic("block", { entered: true });
    response.end("entered");
  } else if (request.url === "/release") {
    if (released) response.end("released");
    else releaseWaiters.add(response);
    response.once("close", () => releaseWaiters.delete(response));
  } else if (request.url === "/admin/release") {
    released = true;
    for (const waiter of releaseWaiters) waiter.end("released");
    releaseWaiters.clear();
    await atomic("block", { entered: false });
    response.end("released");
  } else if (request.url === "/submit" && request.method === "POST") {
    for await (const chunk of request) {
      /* consume synthetic request */
    }
    pending = pending.then(async () => {
      submissions++;
      await atomic("ledger", { submissions });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(String(submissions));
    });
    await pending;
  } else if (request.url === "/file.csv") {
    response.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="actual.csv"',
    });
    response.end("name,value\nkaguya,42\n");
  } else {
    response.writeHead(200, {
      "content-type": "text/html",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    response.end(
      '<input aria-label="unsaved"><fieldset disabled><input aria-label="fieldset disabled"></fieldset><input type="checkbox" aria-label="agree"><input type="radio" name="choice" aria-label="first choice" checked><input type="radio" name="choice" aria-label="second choice"><select aria-label="dynamic choice"><option value="a">A</option><option value="b">B</option></select><output id="dynamic">initial</output><button id="submit">submit once</button><output id="count">0</output><output id="nonce">' +
        nonce +
        `</output><a href="/file.csv">download CSV</a><button id="hide">hide submit</button><button id="show">show submit</button><button id="arm">arm block</button><style></style><script>
document.querySelector('select').onchange=(event)=>{dynamic.textContent='selected '+event.target.value};
submit.onclick=async()=>{count.textContent=await(await fetch('/submit',{method:'POST',body:document.querySelector('input').value})).text()};
hide.onclick=()=>document.styleSheets[0].insertRule('#submit {display:none}',0);
show.onclick=()=>document.styleSheets[0].deleteRule(0);
arm.onclick=async()=>{await fetch('/prepare');setTimeout(()=>{
  const buffer=new SharedArrayBuffer(4), view=new Int32Array(buffer);
  const worker=new Worker(URL.createObjectURL(new Blob(["onmessage=async({data})=>{await fetch(data.url);Atomics.store(new Int32Array(data.buffer),0,1)}"],{type:'text/javascript'})));
  worker.postMessage({buffer,url:location.origin+'/release'});fetch('/entered');
  while(Atomics.load(view,0)===0){} worker.terminate();
},0)};
</script>`,
    );
  }
});
await atomic("ledger", { submissions });
await atomic("block", { entered: false });
await new Promise((resolve) => server.listen(8765, "127.0.0.1", resolve));
await atomic("ready", {
  pid: process.pid,
  url: "http://127.0.0.1:8765",
  nonce,
});
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
});
