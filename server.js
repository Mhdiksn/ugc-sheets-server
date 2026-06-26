// ============================================================================
// UGC Iraq — خادم وسيط لقراءة Google Sheets
// ----------------------------------------------------------------------------
// الفكرة: المتصفح ما يگدر يقرا Google مباشرة (حجب CORS).
// هذا الخادم يقرا الشيت من جهة الخادم (ماكو حجب) ويرجّع البيانات للتطبيق.
// ما يحتاج مفاتيح Google ولا حساب Cloud — بس الشيت لازم يكون منشور (Publish to web).
// ============================================================================

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

// يحوّل أي رابط Google Sheets لقائمة روابط CSV نجرّبها بالترتيب
function buildCsvUrls(sheetUrl) {
  const urls = [];
  try {
    const gidM = sheetUrl.match(/[#&?]gid=([0-9]+)/);
    const gid = gidM ? gidM[1] : null;

    // صيغة النشر للعامة: /d/e/2PACX-.../pubhtml
    const pm = sheetUrl.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pm && pm[1]) {
      const id = pm[1];
      urls.push(`https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv${gid ? `&gid=${gid}` : ""}`);
      urls.push(`https://docs.google.com/spreadsheets/d/e/${id}/pub?single=true&output=csv${gid ? `&gid=${gid}` : ""}`);
      return urls;
    }

    // الصيغة العادية: /d/SHEET_ID/edit
    const m = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (m && m[1]) {
      const id = m[1];
      urls.push(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`);
      urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid ? `&gid=${gid}` : ""}`);
      return urls;
    }
  } catch (e) {}
  return urls;
}

// يجيب محتوى رابط (يتبع التحويلات redirects)
function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("too many redirects"));
    const opts = {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UGC-Sheets-Proxy/1.0)",
        Accept: "text/csv,text/plain,*/*",
      },
    };
    https
      .get(url, opts, (res) => {
        // اتبع التحويل
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          return resolve(fetchUrl(next, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("status " + res.statusCode));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

// يرسل طلب POST لـ Anthropic API ويرجّع الرد (الخادم يكلّم Claude نيابة عن التطبيق)
function callClaude(bodyObj) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error("no_api_key"));

    const payload = JSON.stringify(bodyObj);
    const opts = {
      method: "POST",
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// يقرا جسم الطلب الوارد (JSON) من التطبيق
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new Error("too_large")); // حد 10MB
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// يجرّب كل رابط CSV لحد ما يلگي بيانات صحيحة
async function getSheetCsv(sheetUrl) {
  const urls = buildCsvUrls(sheetUrl);
  if (urls.length === 0) throw new Error("bad_url");
  let lastErr = "fetch_failed";
  for (const u of urls) {
    try {
      const text = await fetchUrl(u);
      const t = (text || "").trim();
      if (t.startsWith("<") || t.includes("<!DOCTYPE") || t.includes("<html")) {
        lastErr = "not_published";
        continue;
      }
      if (t.length === 0) {
        lastErr = "fetch_failed";
        continue;
      }
      return text; // نجح
    } catch (e) {
      lastErr = "fetch_failed";
    }
  }
  throw new Error(lastErr);
}

// ----------------------------------------------------------------------------
// الخادم
// ----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // السماح لأي موقع يتصل (CORS) — حتى التطبيق يگدر يطلب
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, anthropic-version");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // فحص الصحة — يتأكد إن الخادم شغّال (يستخدمه التطبيق)
  if (reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, service: "ugc-app", time: new Date().toISOString() }));
  }

  // الصفحة الرئيسية — يخدم التطبيق نفسه (index.html)
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    try {
      const htmlPath = path.join(__dirname, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, service: "ugc-app", note: "index.html غير موجود — ارفعه مع الخادم", time: new Date().toISOString() }));
    }
  }

  // المسار الرئيسي: /sheet?url=رابط_الشيت
  if (reqUrl.pathname === "/sheet") {
    const sheetUrl = reqUrl.searchParams.get("url");
    if (!sheetUrl) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "missing_url" }));
    }
    try {
      const csv = await getSheetCsv(sheetUrl);
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
      return res.end(csv);
    } catch (e) {
      const code = e.message === "not_published" ? "not_published" : e.message === "bad_url" ? "bad_url" : "fetch_failed";
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: code }));
    }
  }

  // مسار المساعد الذكي: التطبيق يرسل طلبه هنا، والخادم يمرّره لـ Claude
  if (reqUrl.pathname === "/claude" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      let bodyObj;
      try {
        bodyObj = JSON.parse(raw);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "bad_json" }));
      }
      const result = await callClaude(bodyObj);
      // نرجّع رد Claude كما هو للتطبيق
      res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(result.body);
    } catch (e) {
      const code = e.message === "no_api_key" ? "no_api_key" : "claude_failed";
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: code, detail: String(e.message || e) }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => {
  console.log(`UGC Sheets proxy يشتغل على المنفذ ${PORT}`);
});
