#!/usr/bin/env node
/* 我们的本子 · 参考后端（Node 18+，零依赖）
 *
 *   JOURNAL_TOKEN=换成一串随机字 node journal-server.mjs
 *   手机打开  http://<这台机器>:8787/?token=同一串字
 *
 * 做的事：
 *   1. 存页面的数据（db）：/journal/kv/<集合>/<id>，一份一个 JSON 文件，放在 ./journal-data/kv/
 *   2. 存图（assets）：/journal/assets
 *   3. 推变化（SSE）：/journal/events，两个人、手机和 agent 改了都会推
 *   4. 页面要调的工具：/journal/tool/sync_talk、/journal/tool/get_kaomoji（转给你的 App，见 TOOL_HOOKS）
 *   5. 给 agent 读原料：/journal/sources/<YYYY-MM-DD>（照片 EXIF + 聊天 + 吃了吗 + 天气 + 书摘 + 健康）
 *      和 /journal/photos/<id>/publish（把相册里的一张图放进本子，返回 url）
 *
 * 你已经有自己的数据库和相册的话：保持这些路径和返回格式不变，把 sources / publish / TOOL_HOOKS 里读文件的地方换成你自己的就行。
 */
import http from "node:http";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const TOKEN = process.env.JOURNAL_TOKEN || "";
const DATA = path.resolve(process.env.JOURNAL_DATA || path.join(HERE, "journal-data"));
const PAGE = path.resolve(process.env.JOURNAL_PAGE || path.join(HERE, "..", "book", "app.html"));
/* 原料：换成你自己的。照片索引的格式见 BACKEND.md「照片索引」 */
const PHOTO_INDEX = process.env.PHOTO_INDEX || path.join(DATA, "sources", "photos.json");   // [{id,file,local:"2026-09-27 10:39",lat,lon,f,shutter,iso,focal,model,jpg}]
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(DATA, "sources", "photos");           // jpg 所在目录（jpg 字段相对它）
const CHAT_FILE = process.env.CHAT_FILE || path.join(DATA, "sources", "chat.json");        // {"2026-09-27":[{w:"her",t:"09:46",p:"原话"}]}
const FOOD_FILE = process.env.FOOD_FILE || path.join(DATA, "sources", "food.json");        // 吃了吗的导出：{"2026-09-27":[{slot,shop,place,time,dishes:[{name,verdict,note}],note}]}
const BOOK_FILE = process.env.BOOK_FILE || path.join(DATA, "sources", "book.json");        // 书摘：{"2026-09-27":[{book,author,ch,quote,note,who,t}]}
const HEALTH_FILE = process.env.HEALTH_FILE || path.join(DATA, "sources", "health.json");  // 健康：{"2026-09-27":[{k,n,v,s}]}，心情经期这类私密的别放
const TALK_LOG = path.join(DATA, "talk.jsonl");

const ok = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS", "Cache-Control": "no-store" });
  res.end(body == null ? "" : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const safe = s => String(s).replace(/[^\w.\-一-鿿]/g, "_").slice(0, 120);
const kvFile = p => { const parts = p.split("/").filter(Boolean).map(safe); return path.join(DATA, "kv", ...parts) + ".json"; };
const readBody = req => new Promise((r, j) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); req.on("error", j); });
const readJSON = async (f, d = null) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };

/* ---------- 推送 ---------- */
const clients = new Set();
const push = (p, data) => { const line = `data: ${JSON.stringify({ path: p, data })}\n\n`; clients.forEach(c => c.write(line)); };

/* ---------- 页面要调的工具：你的 App 有就转过去 ---------- */
const TOOL_HOOKS = {
  /* 把本子里说的话写回你们的聊天。你们聊天那一边接一个 HTTP 入口的话，填 TALK_WEBHOOK */
  async sync_talk(args) {
    await fs.mkdir(DATA, { recursive: true });
    await fs.appendFile(TALK_LOG, JSON.stringify({ at: Date.now(), ...args }) + "\n");
    if (process.env.TALK_WEBHOOK) await fetch(process.env.TALK_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }).catch(() => {});
    return { written: (args.turns || []).length };
  },
  /* 「吃了吗」联动（另一个开源项目 github.com/TangfanOVO/have-you-eaten）：本子里「吃了吗」栏和 agent 读原料都走这两个钩子。
     接了吃了吗的话，用它自己的数据：把下面两段换成读吃了吗的库（或转调它的 MCP 工具 food_days / food_day）。
     参考实现读 FOOD_FILE：{"2026-09-27":[{slot,shop,place,time,dishes:[{name,verdict,note}],note}]} */
  async food_days(args) { const F = await readJSON(FOOD_FILE, {}); return { days: Object.keys(F).filter(d => (!args.from || d >= args.from) && (!args.to || d <= args.to)).map(d => ({ date: d, n: [].concat(F[d]).reduce((a, m) => a + ((m && m.dishes) || [1]).length, 0) })) }; },
  async food_day(args) { const F = await readJSON(FOOD_FILE, {}); return { date: args.date, meals: [].concat(F[args.date] || []) }; },
  /* 颜文字库：读 sources/kaomoji.json，没有就是空的 */
  async get_kaomoji(args) { const L = await readJSON(path.join(DATA, "sources", "kaomoji.json"), []); return { items: L.slice(0, args && args.limit || 60) }; }
};

/* ---------- 原话核对：写进页面的原话一个字不改 ----------
   agent 写 day/<M.D> 时，chat[]、quote（或 text.quote）、正文里 <her>…</her> 包起来的，都得在那天的原话（CHAT_FILE）里
   一字不差地找得到（不算空格和引号，可以只取一段）。找到的，时间改成原话的时间；找不到的整页拒收（422），
   把最像的那句原话一起退回去，让 agent 照原文重抄。
   为什么放在后端：光靠 agent 自己记着「别改字」靠不住。实际出过：原话是「堪培拉」，页上被重打成了「堤培拉」。 */
const norm = s => String(s || "").replace(/[\s「」『』“”"']/g, "");
const similar = (a, b) => { a = norm(a); b = norm(b); if (!a || !b) return 0; const A = new Set(a); let n = 0; for (const ch of new Set(b)) if (A.has(ch)) n++; return n / Math.max(A.size, 1); };
async function checkWords(k, doc) {
  if (!doc || typeof doc !== "object") return [];
  const all = await readJSON(CHAT_FILE, {});
  const [mo, da] = String(k).split(".").map(Number);
  const keys = Object.keys(all).filter(x => +x.slice(5, 7) === mo && +x.slice(8, 10) === da).sort();
  const today = new Date().toISOString().slice(0, 10);
  const date = keys.filter(x => x <= today).pop() || keys.pop();
  const orig = (date && all[date]) || [];
  const pool = { her: orig.filter(o => o.w === "her"), me: orig.filter(o => o.w !== "her") };
  const find = (t, whos) => { const n = norm(t); if (!n) return null; for (const w of whos) for (const o of pool[w]) if (norm(o.p).includes(n)) return o; return null; };
  const near = (t, whos) => { let best = "", s = -1; for (const w of whos) for (const o of pool[w]) { const v = similar(t, o.p); if (v > s) { s = v; best = o.p; } } return String(best).slice(0, 200); };
  const bad = [];
  (doc.chat || []).forEach((x, i) => {
    if (!x || !x.p) return;
    const whos = x.w === "her" ? ["her"] : ["me"], o = find(x.p, whos);
    if (!o) bad.push({ 哪里: `chat[${i}]`, 写的: String(x.p).slice(0, 200), 那天最像的原话: near(x.p, whos) });
    else if (o.t) x.t = o.t;
  });
  for (const [where, q] of [["quote", doc.quote], ["text.quote", doc.text && doc.text.quote]]) {
    if (!q || !q.p) continue;
    const o = find(q.p, ["her", "me"]);
    if (!o) bad.push({ 哪里: where, 写的: String(q.p).slice(0, 200), 那天最像的原话: near(q.p, ["her", "me"]) });
    else if (o.t) q.t = o.t;
  }
  for (const [key, val] of Object.entries(doc.text || {})) {
    const s = typeof val === "string" ? val : JSON.stringify(val);
    for (const m of s.matchAll(/<her>(.+?)<\/her>/g))
      if (!find(m[1], ["her"])) bad.push({ 哪里: `text.${key} 里的 <her>`, 写的: m[1].slice(0, 200), 那天最像的原话: near(m[1], ["her"]) });
  }
  // 书摘、健康也照原样：书摘的原文要在那天的 BOOK_FILE 里找得到（可以只取一段），健康要跟那天 HEALTH_FILE 记的一样
  const pick = async file => { const A = await readJSON(file, {}); const ks = Object.keys(A).filter(x => +x.slice(5, 7) === mo && +x.slice(8, 10) === da).sort();
    const d = ks.filter(x => x <= today).pop() || ks.pop(); return (d && A[d]) || []; };
  if ((doc.book || []).length) { const L = await pick(BOOK_FILE);
    doc.book.forEach((x, i) => { if (x && x.quote && !L.some(o => norm(o.quote).includes(norm(x.quote)))) bad.push({ 哪里: `book[${i}].quote`, 写的: String(x.quote).slice(0, 200), 那天的书摘: L.map(o => String(o.quote).slice(0, 80)).slice(0, 8) }); }); }
  if ((doc.health || []).length) { const L = await pick(HEALTH_FILE);
    doc.health.forEach((x, i) => { const o = x && L.find(h => h.k === x.k); if (x && (!o || String(o.s) !== String(x.s))) bad.push({ 哪里: `health[${i}]`, 写的: x, 那天记的: o || null }); }); }
  return bad;
}

/* ---------- 给 agent 的原料 ---------- */
async function sources(date) {
  const idx = await readJSON(PHOTO_INDEX, []);
  const photos = idx.filter(p => String(p.local || "").startsWith(date)).map(p => ({ id: p.id || p.file, t: String(p.local).slice(11, 16), lat: p.lat ?? null, lon: p.lon ?? null, f: p.f ?? null, shutter: p.shutter ?? null, iso: p.iso ?? null, focal: p.focal ?? null, model: p.model ?? null, kind: p.kind || "照片", has_jpg: !!p.jpg }));
  const chat = ((await readJSON(CHAT_FILE, {}))[date]) || [];
  const food = (await TOOL_HOOKS.food_day({ date })).meals;   // 吃了吗里那天记过的每一顿
  let wx = null;
  const g = photos.find(p => p.lat != null);
  if (g) try {   // 天气：open-meteo 历史接口，免费不用 key
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${date}&end_date=${date}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=auto`;
    const d = await (await fetch(u)).json(); const D = d.daily;
    wx = { code: D.weather_code[0], hi: D.temperature_2m_max[0], lo: D.temperature_2m_min[0], mm: D.precipitation_sum[0], wind: D.wind_speed_10m_max[0], src: "open-meteo" };
  } catch {}
  return { date, day: `${+date.slice(5, 7)}.${+date.slice(8, 10)}`, photos, geo: photos.filter(p => p.lat != null).map(p => [p.t, p.lat, p.lon, p.id]), shots: photos.map(p => p.t), chat, food, wx,
    book: ((await readJSON(BOOK_FILE, {}))[date]) || [], health: ((await readJSON(HEALTH_FILE, {}))[date]) || [] };
}
async function publishPhoto(id) {
  const idx = await readJSON(PHOTO_INDEX, []);
  const p = idx.find(x => (x.id || x.file) === id);
  if (!p || !p.jpg) return null;
  const buf = await fs.readFile(path.join(PHOTO_DIR, p.jpg));
  return saveAsset(buf, "image/jpeg");
}
async function saveAsset(buf, type) {
  const ext = /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : /gif/.test(type) ? "gif" : "jpg";
  const id = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 20) + "." + ext;
  await fs.mkdir(path.join(DATA, "assets"), { recursive: true });
  await fs.writeFile(path.join(DATA, "assets", id), buf);
  return { id, url: `/journal/assets/${id}` };
}

/* ---------- 路由 ---------- */
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return ok(res, 204);
    if (u.pathname === "/" || u.pathname === "/index.html") {           // 页面本身：把 API 地址填进去
      let html = await fs.readFile(PAGE, "utf8");
      html = html.replace('<meta name="journal-api" content="">', `<meta name="journal-api" content="/journal">`);
      return ok(res, 200, html, "text/html; charset=utf-8");
    }
    if (!u.pathname.startsWith("/journal/")) return ok(res, 404, { error: "not found" });
    const tk = (req.headers.authorization || "").replace(/^Bearer\s+/, "") || u.searchParams.get("token") || "";
    const isAsset = u.pathname.startsWith("/journal/assets/") && req.method === "GET";
    if (TOKEN && tk !== TOKEN && !isAsset) return ok(res, 401, { error: "token" });
    const rest = decodeURIComponent(u.pathname.slice("/journal/".length));

    if (rest === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(": hi\n\n"); clients.add(res); const t = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clients.delete(res); clearInterval(t); }); return;
    }
    if (rest.startsWith("kv/")) {
      const p = rest.slice(3);
      if (p.endsWith("/")) {                                            // 列一个集合
        const dir = path.join(DATA, "kv", ...p.split("/").filter(Boolean).map(safe));
        let files = []; try { files = (await fs.readdir(dir)).filter(f => f.endsWith(".json")); } catch {}
        const rows = await Promise.all(files.map(async f => ({ id: f.slice(0, -5), data: await readJSON(path.join(dir, f)) })));
        return ok(res, 200, rows);
      }
      const f = kvFile(p);
      if (req.method === "GET") { const d = await readJSON(f); return d == null ? ok(res, 404, { error: "none" }) : ok(res, 200, d); }
      if (req.method === "PUT") { const d = JSON.parse((await readBody(req)).toString("utf8") || "null");
        if (p.startsWith("day/")) { const bad = await checkWords(p.slice(4), d);   // 原话核对，见上面 checkWords
          if (bad.length) return ok(res, 422, { error: "有几句不是那天的原话，这一页没写进去。原话一个字不改：照「那天最像的原话」原样抄（可以只取其中一段），对不上的就别放。改好再写一次。", 对不上的: bad }); }
        await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(d)); push(p, d); return ok(res, 200, { ok: 1 }); }
      if (req.method === "DELETE") { await fs.rm(f, { force: true }); push(p, null); return ok(res, 200, { ok: 1 }); }
    }
    if (rest === "assets" && req.method === "POST") return ok(res, 200, await saveAsset(await readBody(req), req.headers["content-type"] || ""));
    if (rest.startsWith("assets/")) {
      const f = path.join(DATA, "assets", safe(rest.slice(7)));
      if (req.method === "DELETE") { await fs.rm(f, { force: true }); return ok(res, 200, { ok: 1 }); }
      if (!fss.existsSync(f)) return ok(res, 404, { error: "none" });
      const type = f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : f.endsWith(".gif") ? "image/gif" : "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" }); return fss.createReadStream(f).pipe(res);
    }
    if (rest.startsWith("tool/") && req.method === "POST") {
      const name = rest.slice(5); const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!TOOL_HOOKS[name]) return ok(res, 404, { error: "tool not here: " + name });
      return ok(res, 200, await TOOL_HOOKS[name](body.args || {}));
    }
    if (rest.startsWith("sources/")) return ok(res, 200, await sources(rest.slice(8)));
    const m = rest.match(/^photos\/(.+)\/publish$/);
    if (m && req.method === "POST") { const a = await publishPhoto(m[1]); return a ? ok(res, 200, a) : ok(res, 404, { error: "no jpg for this photo" }); }
    return ok(res, 404, { error: "not found" });
  } catch (e) { console.error(e); ok(res, 500, { error: String(e && e.message || e) }); }
}).listen(PORT, () => console.log(`我们的本子 · http://localhost:${PORT}/${TOKEN ? "?token=…" : ""}  数据在 ${DATA}`));
