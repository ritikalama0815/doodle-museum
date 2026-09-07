import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";

const BUCKET = "doodles";
const MANIFEST = "gallery.json";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function doodleApi(env) {
  const supabaseUrl = env.VITE_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;

  async function storageRequest(objectPath, { method = "GET", body, contentType, upsert = false } = {}) {
    const headers = {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
    };
    if (contentType) headers["Content-Type"] = contentType;
    if (upsert) headers["x-upsert"] = "true";
    return fetch(`${supabaseUrl}/storage/v1/object/${objectPath}`, {
      method,
      headers,
      body,
    });
  }

  async function readManifest() {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/public/${BUCKET}/${MANIFEST}`);
    if (!res.ok) return [];
    try {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function writeManifest(rows) {
    const res = await storageRequest(`${BUCKET}/${MANIFEST}`, {
      method: "POST",
      body: JSON.stringify(rows),
      contentType: "application/json",
      upsert: true,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`manifest upload failed: ${text}`);
    }
  }

  async function handle(req, res) {
    if (req.method === "GET") {
      try {
        const rows = await readManifest();
        sendJson(res, 200, rows);
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (req.method === "POST") {
      try {
        const raw = await readBody(req);
        const payload = JSON.parse(raw.toString("utf8") || "{}");
        const caption = String(payload.caption ?? "").slice(0, 140);
        const flagged = Boolean(payload.flagged);
        const created_at = payload.created_at || new Date().toISOString();
        const path = payload.path || `public/${Date.now()}-${crypto.randomUUID()}.png`;
        const imageBase64 = String(payload.imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
        if (!imageBase64) {
          sendJson(res, 400, { error: "missing image" });
          return;
        }

        const png = Buffer.from(imageBase64, "base64");
        const upload = await storageRequest(`${BUCKET}/${path}`, {
          method: "POST",
          body: png,
          contentType: "image/png",
          upsert: true,
        });
        if (!upload.ok) {
          sendJson(res, 502, { error: await upload.text() });
          return;
        }

        const row = { path, caption, flagged, created_at };
        const rows = (await readManifest()).filter((item) => item.path !== path);
        rows.unshift(row);
        await writeManifest(rows.slice(0, 400));

        const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
        sendJson(res, 200, { ...row, publicUrl });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    res.statusCode = 405;
    res.end();
  }

  function attach(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split("?")[0];
      if (url !== "/api/drawings") return next();
      handle(req, res);
    });
  }

  return {
    name: "doodle-api",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [doodleApi(env)],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          gallery: resolve(__dirname, "gallery.html"),
        },
      },
    },
  };
});
