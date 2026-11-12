/**
 * 功能概述：为 MCP 集成测试提供独立 Node stdio/HTTP 合成服务源码，不接触真实账号或外部网络。
 * syntheticServerSource 写入测试临时目录后运行；日志精确记录启动、RPC 和副作用次数。
 * 参数控制协议、分页（含空字符串游标）、断连、晚到、认证回显和成功/错误结果 schema；回环控制通道确认状态应用和 barrier 释放。
 * applySyntheticControl 只供测试宿主调用，按 journal 中本进程端点发送状态并等待有界 ACK；不作为 MCP 工具。
 * 本文件无自动运行入口，生产 Server 不导入；测试在失败路径也回收其直接子进程及临时文件。
 */
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

export interface SyntheticControlAck {
  id: string;
  applied: boolean;
  released: { method: string; rpcId: string | number }[];
}
/** 每次读取最新进程的私有回环端点；cleanup 仅在确认进程已退出时允许缺席。 */
export async function applySyntheticControl(
  journalPath: string,
  state: Record<string, unknown>,
  options: { timeoutMs?: number; allowStopped?: boolean } = {},
): Promise<SyntheticControlAck> {
  const rows = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const endpoint = rows.findLast((row) => row.kind === "control-ready");
  if (!endpoint) {
    if (options.allowStopped)
      return { id: "stopped", applied: false, released: [] };
    throw new Error("synthetic-control-not-ready");
  }
  const alive = () => {
    try {
      process.kill(endpoint.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  if (options.allowStopped && !alive())
    return { id: "stopped", applied: false, released: [] };
  const id = randomUUID();
  const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
  const signal = AbortSignal.timeout(options.timeoutMs ?? 2000);
  const abort = () =>
    socket.destroy(new Error("synthetic-control-ack-timeout"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<SyntheticControlAck>((resolve, reject) => {
      let buffer = "";
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({ id, token: endpoint.token, state }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 65536) {
          reject(new Error("synthetic-control-ack-budget"));
          socket.destroy();
          return;
        }
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) return;
        try {
          const ack = JSON.parse(buffer.slice(0, boundary));
          if (
            ack.id !== id ||
            ack.applied !== true ||
            !Array.isArray(ack.released)
          )
            throw new Error("synthetic-control-ack-invalid");
          resolve(ack);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
      socket.once("close", () =>
        reject(new Error("synthetic-control-closed-before-ack")),
      );
    });
  } catch (error) {
    if (options.allowStopped && !alive())
      return { id: "stopped", applied: false, released: [] };
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    socket.destroy();
    if (!socket.closed)
      await new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
  }
}

export const syntheticServerSource = String.raw`
/** 合成 MCP 服务：stdin 或回环 HTTP；每次请求在 journal 记录独立 rpcId。 */
import {readFileSync,appendFileSync} from 'node:fs';
import {createServer as createControlServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const [mode,statePath,journalPath]=process.argv.slice(2);
let currentState=JSON.parse(readFileSync(statePath,'utf8'));
const state=()=>currentState;
const log=value=>appendFileSync(journalPath,JSON.stringify(value)+'\n');
log({kind:'start',pid:process.pid});
const held=[];
let notified=false;
let unknownReplied=false;
const controlToken=randomUUID();
function applyControl(next,id){
  currentState=next;
  if(mode==='stdio'&&state().unknownReply&&!unknownReplied){unknownReplied=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999999,result:{content:[]}})+'\n');}
  if(mode==='stdio'&&state().notify&&!notified){notified=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');log({kind:'notification'});}
  const released=state().release?held.splice(0):[];
  for(const item of released)item.resolve();
  const ack={id,applied:true,released:released.map(({method,rpcId})=>({method,rpcId}))};
  log({kind:'control-applied',...ack});
  return ack;
}
const control=createControlServer(socket=>{
  socket.setTimeout(2000,()=>socket.destroy());
  socket.on('error',()=>{});
  let buffer='';
  socket.on('data',chunk=>{
    buffer+=chunk.toString();
    if(buffer.length>65536){socket.destroy();return;}
    const boundary=buffer.indexOf('\n');if(boundary<0)return;
    try{const input=JSON.parse(buffer.slice(0,boundary));
      if(input.token!==controlToken||typeof input.id!=='string'||!input.state||typeof input.state!=='object'){socket.destroy();return;}
      const ack=applyControl(input.state,input.id);
      socket.end(state().dropControlAck?'':JSON.stringify(ack)+'\n');
    }catch{socket.destroy();}
  });
});
await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
log({kind:'control-ready',pid:process.pid,port:control.address().port,token:controlToken});
async function hold(request){
  await new Promise(resolve=>{held.push({resolve,method:request.method,rpcId:request.id});log({kind:'held',method:request.method,rpcId:request.id});});
  log({kind:'released',method:request.method,rpcId:request.id});
}
function tool(name){return {name,description:'synthetic '+name,inputSchema:{type:'object',properties:{value:{type:state().schemaType||'number'}},required:['value'],additionalProperties:false},...(state().outputSchema?{outputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}}:{}),annotations:{readOnlyHint:true,idempotentHint:true}};}
async function handle(request,reply,drop,authorization=""){
  const current=state();log({kind:'request',rpcId:request.id??null,method:request.method,params:request.params});
  if(request.id===undefined)return;
  const complete=result=>reply({jsonrpc:'2.0',id:request.id,result:current.protocol==='2026-07-28'&&request.method!=='server/discover'?{resultType:'complete',ttlMs:0,cacheScope:'private',...result}:result});
  if(request.method==='server/discover'){reply({jsonrpc:'2.0',id:request.id,result:{supportedVersions:[current.protocol],capabilities:current.unsupported?{}:{tools:{listChanged:true},resources:{},prompts:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}}}});return;}
  if(request.method==='initialize'){complete({protocolVersion:current.protocol,capabilities:current.unsupported?{}:{tools:{listChanged:true},resources:{},prompts:{}},serverInfo:{name:'synthetic',version:'1'}});return;}
  if(request.method==='tools/list'){
    if(current.holdList&&!current.release)await hold(request);
    const cursor=request.params?.cursor;
    complete({tools:[tool(cursor!==undefined?'increment':'echo')],...((cursor===undefined||current.loopPages)?{nextCursor:current.loopPages?'repeat':current.emptyCursor?'':'second'}:{})});return;
  }
  if(request.method==='tools/call'){
    log({kind:'effect',operation:request.params.name});
    if(current.worker){const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(worker,'spawn');log({kind:'worker',pid:worker.pid});}
    if(current.exit){process.exit(0);return;}
    if(current.drop){drop();return;}
    if(current.headerMismatch){reply({jsonrpc:'2.0',id:request.id,error:{code:-32020,message:'mismatch'}});return;}
    if(current.inputRequired){reply({jsonrpc:'2.0',id:request.id,result:{resultType:'input_required',inputRequests:{},requestState:'opaque'}});return;}
    if(current.hold&&!current.release)await hold(request);
    const token=authorization.replace(/^Bearer[ \t]+/i,'');
    complete({content:[{type:'text',text:current.echoAuth?token:current.echoSecret?process.env.SYNTHETIC_SECRET:JSON.stringify(request.params.arguments)}],...(current.echoAuth?{structuredContent:{[token]:'credential-key'}}:current.outputSchema&&!current.missingOutput?{structuredContent:current.isError?{error:'synthetic failure'}:current.invalidOutput?{value:'wrong-type'}:request.params.arguments}:{}),isError:!!current.isError});log({kind:'returned'});return;
  }
  if(request.method==='resources/list'){complete({resources:[{name:'test',uri:'fixture://allowed/item',mimeType:'text/plain'}]});return;}
  if(request.method==='resources/templates/list'){complete({resourceTemplates:[{name:'template',uriTemplate:'fixture://allowed/{id}'}]});return;}
  if(request.method==='resources/read'){complete({contents:[{uri:current.escapeResource?'fixture://denied/item':request.params.uri,mimeType:'text/plain',text:'untrusted resource'}]});return;}
  if(request.method==='prompts/list'){complete({prompts:[{name:'summarize',arguments:[{name:'topic',required:true}]}]});return;}
  if(request.method==='prompts/get'){complete({messages:[{role:'user',content:{type:'text',text:'untrusted prompt '+request.params.arguments.topic}}]});return;}
  reply({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported'}});
}
if(mode==='stdio'){
  const reader=createInterface({input:process.stdin});
  reader.on('line',line=>{void handle(JSON.parse(line),value=>process.stdout.write(JSON.stringify(value)+'\n'),()=>process.exit(0));});
  reader.on('close',()=>process.exit(0));
}else{
  const server=createServer(async(req,res)=>{
    log({kind:'http',method:req.method,authorization:req.headers.authorization||null,session:req.headers['mcp-session-id']||null});
    if(state().auth&&req.headers.authorization!=='Bearer synthetic-token'){res.writeHead(401).end();return;}
    if(req.method==='DELETE'){res.writeHead(200).end();return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString());
    res.on('close',()=>log({kind:'network-close',method:request.method}));
    if(request.id===undefined){res.writeHead(202).end();void handle(request,()=>{},()=>{});return;}
    await handle(request,value=>{
      if(state().sse){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify(value)+'\n\n');}
      else {res.writeHead(200,{'content-type':'application/json',...(request.method==='initialize'?{'mcp-session-id':'synthetic-session'}:{})});res.end(JSON.stringify(value));}
    },()=>res.destroy(),req.headers.authorization||"");
  });
  server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
}
`;
