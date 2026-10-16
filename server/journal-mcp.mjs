#!/usr/bin/env node
/* 我们的本子 · 给 agent 用的 MCP 工具（stdio，零依赖）
 * 接在 journal-server.mjs（或你自己实现的同一套接口）前面，agent 就能：读某天的原料、把照片放进本子、写一页、报进度、读批注、回批注。
 *
 *   JOURNAL_URL=http://localhost:8787 JOURNAL_TOKEN=xxx node journal-mcp.mjs
 *
 * Claude Code 里装：claude mcp add journal -- node /路径/journal-mcp.mjs   （环境变量用 -e 传）
 * 你已经有 MCP 服务的话，把下面 TOOLS 抄过去当成你自己的工具也行，名字和参数别改，AGENT.md 是照着这套写的。
 */
const BASE = (process.env.JOURNAL_URL || "http://localhost:8787").replace(/\/$/, "") + "/journal";
const TOKEN = process.env.JOURNAL_TOKEN || "";
const H = (x = {}) => Object.assign(TOKEN ? { Authorization: "Bearer " + TOKEN } : {}, x);
const api = async (m, p, body) => { const r = await fetch(BASE + p, { method: m, headers: H(body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined }); if (r.status === 404) return null; if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${await r.text()}`); return r.json(); };   // 原话核对拒收时，原因和最像的原话都在 body 里，原样带给 agent
const kv = { get: p => api("GET", "/kv/" + p), set: (p, d) => api("PUT", "/kv/" + p, d), list: c => api("GET", "/kv/" + c + "/") };
const dayKey = d => { const m = String(d).match(/(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? `${+m[2]}.${+m[3]}` : String(d); };

const TOOLS = [
  { name: "journal_sources", description: "读某一天做手帐的原料：那天相册里每张照片的时间、经纬度、光圈快门 ISO 焦距（不含图本身），聊天原话，吃了吗，天气。先调这个再决定用哪几张。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] },
    run: a => api("GET", "/sources/" + a.date) },
  { name: "journal_publish_photo", description: "把相册里的一张照片放进本子（传成图片资源），返回 {url}。写 day 的 photos[].src 就用这个 url。只放要用的几张。",
    inputSchema: { type: "object", properties: { photo_id: { type: "string" } }, required: ["photo_id"] },
    run: a => api("POST", `/photos/${encodeURIComponent(a.photo_id)}/publish`) },
  { name: "journal_progress", description: "往她手机上那条「枫在做 X 月 X 日」报一步进度，她会看到一行一行亮起来。开始做之前先调一次 status=making。",
    inputSchema: { type: "object", properties: { date: { type: "string" }, step: { type: "string", description: "比如：看照片" }, detail: { type: "string", description: "比如：46 张，挑了 6 张" }, title: { type: "string" } }, required: ["date", "step"] },
    run: async a => { const k = dayKey(a.date); const cur = (await kv.get("day/" + k)) || { day: k, status: "making", steps: [] };
      if (cur.status !== "making") { cur.status = "making"; cur.steps = []; }
      cur.steps = (cur.steps || []).map(s => ({ ...s, ok: true })).concat({ a: a.step, b: a.detail || "", ok: false }); if (a.title) cur.title = a.title; cur.ts = Date.now(); await kv.set("day/" + k, cur); return { ok: 1 }; } },
  { name: "journal_write_day", description: "把一天写成一页（day/<M.D>）。只给原料，路线、快门条、坐标、邮戳、哪些零件藏起来，页面自己算。字段见 BACKEND.md「day/<日期>」。写完 status 自动是 done，她手机上会亮「做好了」。",
    inputSchema: { type: "object", properties: { date: { type: "string" }, page: { type: "object", description: "title, at, en, region, layout, style, text{p1,p2,cap,ann,pen{text,margin},quote{p,t}}, wx, photos[{src,t,lat,lon,f,shutter,iso,focal,note,role}], geo, shots, places[{n,lat,lon}], chat[{w,t,p}], food{meal,at,t,items,q}" } }, required: ["date", "page"] },
    run: async a => { const k = dayKey(a.date); const cur = (await kv.get("day/" + k)) || {}; const steps = (cur.steps || []).map(s => ({ ...s, ok: true }));
      const doc = { ...a.page, day: k, status: "done", by: a.page.by || "me", steps, ts: Date.now() }; await kv.set("day/" + k, doc); return { ok: 1, day: k }; } },
  { name: "journal_read_page", description: "看她在某天那页上做了什么：她贴的贴纸、自己打的字（m 字段）、放的照片、藏掉的零件、存过的代、留的批注。",
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
    run: async a => { const k = dayKey(a.date); const notes = ((await kv.list("notes")) || []).map(r => r.data).filter(n => n && n.day === k);
      return { day: await kv.get("day/" + k), page: await kv.get("page/" + k), gens: await kv.get("gens/" + k), notes }; } },
  { name: "journal_reply_note", description: "回她在某页上留的批注（贴在同一个气泡里）。",
    inputSchema: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id", "text"] },
    run: async a => { const root = await kv.get("notes/" + a.note_id); if (!root) throw new Error("没有这条批注"); const id = "n" + Date.now().toString(36);
      await kv.set("notes/" + id, { id, day: root.day, who: "me", at: Date.now(), re: root.re || root.id, text: a.text }); return { ok: 1, id }; } },
  { name: "journal_asks", description: "看她在本子里点「交给枫」留下的请求（还没做的）。做完调 journal_write_day 后再用 done=true 关掉。",
    inputSchema: { type: "object", properties: { done_id: { type: "string", description: "要关掉的请求 id，可选" } } },
    run: async a => { if (a.done_id) { const r = await kv.get("ask/" + a.done_id); if (r) await kv.set("ask/" + a.done_id, { ...r, status: "done" }); }
      return ((await kv.list("ask")) || []).map(r => r.data).filter(x => x && x.status !== "done"); } }
];

/* ---------- MCP over stdio ---------- */
let buf = "";
const send = m => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params && params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "journal", version: "1.0.0" } } });
      else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      else if (method === "tools/call") { const t = TOOLS.find(x => x.name === params.name); if (!t) throw new Error("no tool " + params.name);
        const r = await t.run(params.arguments || {}); send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] } }); }
      else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
      else if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    } catch (e) { if (id != null) send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } }); }
  }
});
