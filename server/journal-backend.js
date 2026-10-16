/* 我们的本子 · 后端适配层
 * 页面只认一套接口：window.claude.use("db" | "assets" | "mcp")，跟 claude.ai Artifact 的运行时一样。
 * 在 claude.ai 里打开：用 Claude 自己的运行时，这段什么都不做。
 * 在你自己的 App / 网页里打开：提供 window.journalBackend，或者给一个 API 地址，这段把它包成同样的接口。
 *
 * 给 API 地址的三种写法（任选其一）：
 *   1) 页面 URL 带 ?api=https://你的服务器/journal&token=xxx
 *   2) <meta name="journal-api" content="https://你的服务器/journal"> 和 <meta name="journal-token" content="xxx">
 *   3) WebView 注入：window.JOURNAL_API="…"; window.JOURNAL_TOKEN="…"
 * 或者 App 直接注入 window.journalBackend = { get, set, del, list, upload, callTool, watch? }（见 BACKEND.md）
 */
(function(){
  if (window.claude && !window.journalBackend) return;            // claude.ai 里：用原生运行时
  const qs = new URLSearchParams(location.search);
  const meta = n => { const m = document.querySelector(`meta[name="${n}"]`); return m && m.content; };
  const API = (window.JOURNAL_API || qs.get("api") || meta("journal-api") || "").replace(/\/$/, "");
  const TOKEN = window.JOURNAL_TOKEN || qs.get("token") || meta("journal-token") || "";
  if (!window.journalBackend && API) window.journalBackend = restBackend(API, TOKEN);
  const B = window.journalBackend;
  if (!B) return;                                                   // 什么都没有：页面自己存这台设备

  /* ---------- REST 实现：服务器按 BACKEND.md 写就行 ---------- */
  function restBackend(api, token){
    const H = (extra={}) => Object.assign(token ? { Authorization: "Bearer " + token } : {}, extra);
    const j = async r => { if (r.status === 404) return null; if (!r.ok) throw Object.assign(new Error("http " + r.status), { code: "http_" + r.status }); return r.status === 204 ? null : r.json(); };
    const enc = p => p.split("/").map(encodeURIComponent).join("/");
    return {
      get:  path => fetch(`${api}/kv/${enc(path)}`, { headers: H() }).then(j),
      set:  (path, data) => fetch(`${api}/kv/${enc(path)}`, { method: "PUT", headers: H({ "Content-Type": "application/json" }), body: JSON.stringify(data) }).then(j),
      del:  path => fetch(`${api}/kv/${enc(path)}`, { method: "DELETE", headers: H() }).then(j),
      list: col => fetch(`${api}/kv/${enc(col)}/`, { headers: H() }).then(j).then(x => x || []),
      upload: async blob => fetch(`${api}/assets`, { method: "POST", headers: H({ "Content-Type": blob.type || "application/octet-stream" }), body: blob }).then(j),
      removeAsset: id => fetch(`${api}/assets/${encodeURIComponent(id)}`, { method: "DELETE", headers: H() }).then(j),
      callTool: (tool, args, server) => fetch(`${api}/tool/${encodeURIComponent(tool)}`, { method: "POST", headers: H({ "Content-Type": "application/json" }), body: JSON.stringify({ server, args }) }).then(j),
      watch: cb => {                                                // 服务器推：SSE，每条 {path, data|null}
        try { const es = new EventSource(`${api}/events${token ? "?token=" + encodeURIComponent(token) : ""}`);
          es.onmessage = e => { try { const m = JSON.parse(e.data); cb(m.path, m.data); } catch(_){} };
          return () => es.close(); } catch(e){ return null; }
      }
    };
  }

  /* ---------- 把 get/set/list 包成 db.doc / db.collection / onSnapshot ---------- */
  function makeDB(B){
    const subs = new Set();                                         // {kind:"doc"|"col", path, where, cb}
    const cache = new Map();                                        // path -> data
    const snapDoc = (path, data) => ({ id: path.split("/").pop(), exists: data != null, data: () => data == null ? undefined : JSON.parse(JSON.stringify(data)), metadata: { hasPendingWrites: false } });
    const colOf = path => path.split("/").slice(0, -1).join("/");
    const match = (s, path) => s.kind === "doc" ? s.path === path : colOf(path) === s.path;
    async function fire(path){
      for (const s of subs) if (match(s, path)) {
        try { if (s.kind === "doc") s.cb(snapDoc(path, cache.get(path) ?? null)); else s.cb(await queryCol(s.path, s.where)); } catch(e){ s.err && s.err(e); }
      }
    }
    async function queryCol(col, where){
      const rows = await B.list(col);
      rows.forEach(r => cache.set(col + "/" + r.id, r.data));
      const docs = rows.filter(r => !where || (r.data && r.data[where[0]] === where[2])).map(r => snapDoc(col + "/" + r.id, r.data));
      return { docs, empty: !docs.length, size: docs.length };
    }
    if (B.watch) B.watch((path, data) => { if (data == null) cache.delete(path); else cache.set(path, data); fire(path); });
    else setInterval(() => { subs.forEach(async s => { try { if (s.kind === "doc") { const d = await B.get(s.path); const o = JSON.stringify(cache.get(s.path) ?? null), n = JSON.stringify(d ?? null); if (o !== n) { cache.set(s.path, d); s.cb(snapDoc(s.path, d)); } } else s.cb(await queryCol(s.path, s.where)); } catch(e){} }); }, 8000);
    const doc = path => ({
      id: path.split("/").pop(), path,
      get: async () => { const d = await B.get(path); cache.set(path, d); return snapDoc(path, d); },
      set: async data => { cache.set(path, data); await B.set(path, data); fire(path); },
      update: async patch => { const cur = cache.has(path) ? cache.get(path) : await B.get(path); const next = Object.assign({}, cur || {}, patch); cache.set(path, next); await B.set(path, next); fire(path); },
      delete: async () => { cache.delete(path); await B.del(path); fire(path); },
      onSnapshot(cb, err){ const s = { kind: "doc", path, cb, err }; subs.add(s); this.get().then(cb).catch(e => err && err(e)); return () => subs.delete(s); }
    });
    const collection = col => {
      const mk = where => ({
        doc: id => doc(col + "/" + (id || ("d" + Date.now().toString(36)))),
        where: (f, op, v) => mk([f, op, v]),
        get: () => queryCol(col, where),
        onSnapshot(cb, err){ const s = { kind: "col", path: col, where, cb, err }; subs.add(s); queryCol(col, where).then(cb).catch(e => err && err(e)); return () => subs.delete(s); }
      });
      return mk(null);
    };
    return { doc, collection };
  }

  const DB = makeDB(B);
  window.claude = {
    backend: "journal",
    use: async cap => {
      if (cap === "db") return DB;
      if (cap === "assets") return { upload: blob => B.upload(blob), delete: id => B.removeAsset ? B.removeAsset(id) : null };
      if (cap === "mcp") return { callTool: (server, tool, args) => B.callTool(tool, args, server) };
      throw Object.assign(new Error("capability not provided: " + cap), { code: "not_in_manifest" });
    }
  };
})();
