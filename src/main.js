import { createClient } from "@supabase/supabase-js";

/* =========================
   Supabase
========================= */
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
);
const BUCKET = "doodles";
const TABLE = "drawings";
const LOCAL_GALLERY_KEY = "doodle-museum-works";

/* =========================
   DOM 
========================= */
const galleryEl = document.getElementById("gallery");
const statusEl = document.getElementById("status");

const canvas = document.getElementById("canvas");
let ctx = null;

const captionEl = document.getElementById("caption");
const submitBtn = document.getElementById("submit");
const clearBtn = document.getElementById("clear");
const brushSizeEl = document.getElementById("brushSize");
const eraserSizeEl = document.getElementById("eraserSize");
const colorWheel = document.getElementById("colorWheel");
const wheelMarker = document.getElementById("wheelMarker");
const colorValueEl = document.getElementById("colorValue");
const colorPreview = document.getElementById("colorPreview");
const eraserBtn = document.getElementById("eraser");

const marqueeEl = document.getElementById("marquee");
const trackEl = document.getElementById("track");
const row1 = document.getElementById("row1");
const row2 = document.getElementById("row2");

/* =========================
   Helpers
========================= */
function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const FRAMES = [
  { src: "/images/frame-wide.png", stageRatio: "3 / 2", orient: "h", win: { left: 9, right: 9, top: 14, bottom: 17 } },
  { src: "/images/frame-vertical.png", stageRatio: "3 / 4", orient: "v", win: { left: 18, right: 18, top: 12, bottom: 13 } },
  { src: "/images/frame-empty.png", stageRatio: "4 / 3", orient: "h", win: { left: 7, right: 7, top: 10, bottom: 12 } },
];

function pickRandomFrame() {
  return FRAMES[Math.floor(Math.random() * FRAMES.length)];
}

function publicUrlFor(path) {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base || !path) return "";
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

function urlForRow(row) {
  if (!row) return "";
  return row.publicUrl || row.dataUrl || publicUrlFor(row.path);
}

function readLocalGallery() {
  try {
    const rows = JSON.parse(localStorage.getItem(LOCAL_GALLERY_KEY) || "[]");
    return Array.isArray(rows) ? rows.filter((row) => row && !row.flagged) : [];
  } catch {
    return [];
  }
}

function saveLocalWork(row) {
  const rows = readLocalGallery().filter((item) => item.path !== row.path);
  rows.unshift(row);
  localStorage.setItem(LOCAL_GALLERY_KEY, JSON.stringify(rows.slice(0, 40)));
}

async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return dataUrl;
}

async function appendGalleryManifest(row) {
  try {
    const res = await fetch(publicUrlFor("gallery.json"));
    const existing = res.ok ? await res.json() : [];
    const next = [row, ...(Array.isArray(existing) ? existing.filter((item) => item.path !== row.path) : [])].slice(0, 400);
    const blob = new Blob([JSON.stringify(next)], { type: "application/json" });
    await supabase.storage.from(BUCKET).upload("gallery.json", blob, {
      contentType: "application/json",
      upsert: true,
    });
  } catch {}
}

async function fetchGalleryRows(limit = 50) {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    if (!row?.path || seen.has(row.path)) return;
    seen.add(row.path);
    rows.push(row);
  };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("path, caption, flagged, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!error && data) data.forEach(add);
  } catch {}

  try {
    const res = await fetch(publicUrlFor("gallery.json"));
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) data.forEach(add);
    }
  } catch {}

  try {
    const res = await fetch("/api/drawings");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) data.forEach(add);
    }
  } catch {}

  readLocalGallery().forEach(add);

  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return rows.slice(0, limit);
}

async function persistDrawing({ blob, caption, flagged, path, created_at, dataUrl }) {
  try {
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: "image/png", upsert: false });

    if (!uploadError) {
      const { error: insertError } = await supabase
        .from(TABLE)
        .insert([{ path, caption, flagged }]);
      if (insertError) console.error(insertError);
      await appendGalleryManifest({ path, caption, flagged, created_at });
      return { path, caption, flagged, created_at, publicUrl: publicUrlFor(path) };
    }
  } catch (error) {
    console.error(error);
  }

  try {
    const res = await fetch("/api/drawings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption,
        flagged,
        path,
        created_at,
        imageBase64: dataUrl,
      }),
    });
    if (res.ok) return await res.json();
  } catch {}

  return null;
}

/* =========================
   addToGallery() HERE
========================= */

function addToGallery(publicUrl, caption, flagged, createdAt, prepend = false) {
  if (!galleryEl) return;
  const wrap = buildArtNode(
    publicUrl,
    caption,
    flagged,
    createdAt,
    pickRandomFrame()
  );
  if (prepend) galleryEl.prepend(wrap);
  else galleryEl.appendChild(wrap);
}

/* =========================
   loadGallery() HERE
========================= */

async function loadGallery(limit = 50, randomize = false) {
  if (!galleryEl) return;

  try {
    let rows = await fetchGalleryRows(randomize ? Math.max(limit * 3, limit) : limit);
    if (randomize) rows = shuffleArray(rows).slice(0, limit);

    galleryEl.replaceChildren();
    for (const row of rows) {
      addToGallery(urlForRow(row), row.caption ?? "", !!row.flagged, row.created_at);
    }
  } catch (error) {
    console.error(error);
  }
} 


/* =========================
   Color wheel + canvas
========================= */
let strokeColor = "#111111";
const hsv = { h: 0, s: 0, v: 0.07 };
let pickingWheel = false;
let isErasing = false;

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function setErasing(on) {
  isErasing = on;
  eraserBtn?.classList.toggle("active", on);
}

function applyStrokeColor() {
  const [r, g, b] = hsvToRgb(hsv.h, hsv.s, hsv.v);
  strokeColor = rgbToHex(r, g, b);
  if (colorPreview) colorPreview.style.background = strokeColor;
  if (colorValueEl) {
    const [hr, hg, hb] = hsvToRgb(hsv.h, hsv.s, 1);
    colorValueEl.style.setProperty("--shade-end", rgbToHex(hr, hg, hb));
  }
  setErasing(false);
}

function drawColorWheel() {
  if (!colorWheel) return;
  const wctx = colorWheel.getContext("2d", { willReadFrequently: true });
  const size = colorWheel.width;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = cx;
  const img = wctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      if (dist > radius) {
        img.data[i + 3] = 0;
        continue;
      }
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const sat = dist / radius;
      const [r, g, b] = hsvToRgb(hue, sat, 1);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  wctx.putImageData(img, 0, 0);
}

function updateWheelMarker() {
  if (!wheelMarker || !colorWheel) return;
  const size = colorWheel.getBoundingClientRect().width;
  const cx = size / 2;
  const radius = cx - 1;
  const rad = (hsv.h * Math.PI) / 180;
  wheelMarker.style.left = `${cx + Math.cos(rad) * hsv.s * radius}px`;
  wheelMarker.style.top = `${cx + Math.sin(rad) * hsv.s * radius}px`;
}

function pickFromWheel(e) {
  if (!colorWheel) return;
  const rect = colorWheel.getBoundingClientRect();
  const size = colorWheel.width;
  const x = (e.clientX - rect.left) * (size / rect.width);
  const y = (e.clientY - rect.top) * (size / rect.height);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const radius = cx;
  hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  hsv.s = Math.min(dist / radius, 1);
  if (hsv.v < 0.2) {
    hsv.v = 1;
    if (colorValueEl) colorValueEl.value = "100";
  }
  applyStrokeColor();
  updateWheelMarker();
}

function initColorWheel() {
  if (!colorWheel) return;

  drawColorWheel();
  applyStrokeColor();
  updateWheelMarker();

  colorWheel.addEventListener("pointerdown", (e) => {
    pickingWheel = true;
    try { colorWheel.setPointerCapture(e.pointerId); } catch {}
    pickFromWheel(e);
  });
  colorWheel.addEventListener("pointermove", (e) => {
    if (pickingWheel) pickFromWheel(e);
  });
  colorWheel.addEventListener("pointerup", () => { pickingWheel = false; });
  colorWheel.addEventListener("pointercancel", () => { pickingWheel = false; });

  colorValueEl?.addEventListener("input", () => {
    hsv.v = Number(colorValueEl.value) / 100;
    applyStrokeColor();
  });

  eraserBtn?.addEventListener("click", () => {
    setErasing(!isErasing);
  });
}

function applyPencilCursor() {
  if (!canvas) return;

  const pixels = [
    "tk..............",
    "kTkk............",
    ".kyyk...........",
    ".kyyyk..........",
    "..kyyyk.........",
    "..kyyyyk........",
    "...kyyyyk.......",
    "...kyymmk.......",
    "....kmmmmk......",
    "....kmmmmk......",
    ".....keeeek.....",
    ".....keeeek.....",
    "......keeek.....",
    "......kpppk.....",
    ".......kkk......",
    "................",
  ];
  const palette = {
    t: "#2c2c2c",
    T: "#5a5a5a",
    k: "#1a1208",
    y: "#f0c44c",
    m: "#c8c8c8",
    e: "#ff9bb5",
    p: "#e07090",
  };
  const scale = 2;
  const size = pixels.length * scale;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const cctx = c.getContext("2d");
  cctx.imageSmoothingEnabled = false;

  for (let y = 0; y < pixels.length; y++) {
    for (let x = 0; x < pixels[y].length; x++) {
      const color = palette[pixels[y][x]];
      if (!color) continue;
      cctx.fillStyle = color;
      cctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  canvas.style.cursor = `url("${c.toDataURL("image/png")}") 1 1, crosshair`;
}

function getBrushSize() {
  const n = Number(brushSizeEl?.value ?? 6);
  return Number.isFinite(n) ? n : 6;
}

function getEraserSize() {
  const n = Number(eraserSizeEl?.value ?? 16);
  return Number.isFinite(n) ? n : 16;
}

function getToolSize() {
  return isErasing ? getEraserSize() : getBrushSize();
}

function clearCanvas() {
  if (!canvas || !ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}
clearCanvas();

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

let isDrawing = false;

function startDraw(e) {
  if (!canvas || !ctx) return;
  isDrawing = true;
  const { x, y } = getPos(e);
  ctx.beginPath();
  ctx.moveTo(x, y);
}

function draw(e) {
  if (!canvas || !ctx || !isDrawing) return;

  const { x, y } = getPos(e);

  ctx.lineWidth = getToolSize();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = isErasing ? "destination-out" : "source-over";
  ctx.strokeStyle = isErasing ? "#000000" : strokeColor;

  ctx.lineTo(x, y);
  ctx.stroke();

  if (e.cancelable) e.preventDefault();
}

function endDraw() {
  if (!canvas || !ctx) return;
  isDrawing = false;
  ctx.closePath();
  ctx.globalCompositeOperation = "source-over";
}

function decideFlagging(pixelData) {
  let nonWhite = 0;
  const totalPixels = pixelData.length / 4;

  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const a = pixelData[i + 3];
    if (a === 0) continue;
    const isWhite = r > 245 && g > 245 && b > 245;
    if (!isWhite) nonWhite++;
  }

  return nonWhite / totalPixels < 0.003;
}

function canvasToBlob() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png");
  });
}

function findContentBounds(imageData, w, h) {
  const data = imageData.data;

  let minX = w, minY = h, maxX = -1, maxY = -1;

  // treat anything not near-white as "ink"
  const isInk = (r,g,b,a) => a > 10 && !(r > 245 && g > 245 && b > 245);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (isInk(r,g,b,a)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) return null; // nothing drawn
  return { minX, minY, maxX, maxY };
}

function makeCenteredSquarePng(canvas, pad = 24) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  

  const bounds = findContentBounds(img, w, h);
  if (!bounds) return canvas; // blank

  // crop bounds + padding
  const bw = bounds.maxX - bounds.minX + 1;
  const bh = bounds.maxY - bounds.minY + 1;

  const size = Math.max(bw, bh) + pad * 2;

  // temp canvas for centered export
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const octx = out.getContext("2d");

  // center the crop into the square
  const dx = Math.floor((size - bw) / 2);
  const dy = Math.floor((size - bh) / 2);

  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, size, size);
  octx.drawImage(
    canvas,
    bounds.minX, bounds.minY, bw, bh,  // source crop
    dx, dy, bw, bh                     // destination centered
  );

  return out;
}

/* =========================
   submitDrawing() HERE
========================= */
async function submitDrawing() {
  if (!canvas || !ctx) return;
  try {
    const caption = (captionEl?.value ?? "").trim().slice(0, 140);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const flagged = decideFlagging(imageData.data);
    if (flagged) return;
    const exportCanvas = makeCenteredSquarePng(canvas, 32);
    const blob = await new Promise((resolve, reject) => {
      exportCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });

    const created_at = new Date().toISOString();
    const path = `public/${Date.now()}-${crypto.randomUUID()}.png`;
    const dataUrl = await blobToBase64(blob);

    addToGallery(dataUrl, caption, flagged, created_at, true);
    saveLocalWork({ path, caption, flagged, created_at, dataUrl });
    clearCanvas();
    if (captionEl) captionEl.value = "";

    await persistDrawing({ blob, caption, flagged, path, created_at, dataUrl });
  } catch (error) {
    console.error(error);
  }
}



// Keep a set so we don't spam duplicates too much
const seenPaths = new Set();

function buildArtNode(publicUrl, title, flagged, createdAt, frame) {
  const monthYear = createdAt
    ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(createdAt))
    : "";

  const wrap = document.createElement("div");
  wrap.className = "artCard";

  wrap.innerHTML = `
    <div class="frameStage">
      <div class="artWindow">
        <img src="${publicUrl}" alt="${escapeHtml(title)}" loading="lazy" />
      </div>
      <img class="frameImg" src="${frame.src}" alt="" onerror="this.style.display='none'" />
    </div>

    <div class="placard">
      <div class="placardTitle">${escapeHtml(title || "Untitled")}</div>
      <div class="placardMeta">Anonymous${monthYear ? ` · ${monthYear}` : ""}</div>
    </div>
  `;

  // Apply frame variables (uses your existing frame system)
  const stage = wrap.querySelector(".frameStage");
  stage.style.setProperty("--stage-ratio", frame.stageRatio);
  stage.style.setProperty("--win-left", `${frame.win.left}%`);
  stage.style.setProperty("--win-right", `${frame.win.right}%`);
  stage.style.setProperty("--win-top", `${frame.win.top}%`);
  stage.style.setProperty("--win-bottom", `${frame.win.bottom}%`);

  // Optional blur
  // if (flagged) {
  //   const img = wrap.querySelector(".artWindow img");
  //   if (img) img.style.filter = "blur(10px) saturate(0.7)";
  // }

  const frameImg = wrap.querySelector(".frameImg");
  if (frameImg) {
    frameImg.addEventListener("error", () => {
      frameImg.style.display = "none";
    });
  }

  return wrap;
}

async function fetchRandomRows(count = 200) {
  const rows = await fetchGalleryRows(Math.max(count, 40));
  const shuffled = shuffleArray(rows);
  const picked = [];

  for (const row of shuffled) {
    if (picked.length >= count) break;
    if (!row?.path) continue;
    if (seenPaths.has(row.path)) continue;
    seenPaths.add(row.path);
    picked.push(row);
  }

  return picked;
}

async function repeatMarquee(count = 200) {
  try {
    if (!row1 || !row2) {
      return;
    }

    const existing =
      row1.querySelectorAll(".artCard").length +
      row2.querySelectorAll(".artCard").length;

    if (existing === 0) {
      const rows = await fetchRandomRows(count);

      if (!rows.length) {
        return;
      }

      rows.forEach((row, idx) => {
        if (!row?.path) return;

        const artUrl = urlForRow(row);

        const frame = (typeof pickFrameForPath === "function")
          ? pickFrameForPath(row.path)
          : pickRandomFrame();

        const node = buildArtNode(
          artUrl,
          row.caption ?? "",
          !!row.flagged,
          row.created_at,
          frame
        );

        (idx % 2 === 0 ? row1 : row2).appendChild(node);
      });

      return;
    }

    // REPEAT

    const frag1 = document.createDocumentFragment();
    const frag2 = document.createDocumentFragment();

    row1.querySelectorAll(".artCard").forEach((card) => frag1.appendChild(card.cloneNode(true)));
    row2.querySelectorAll(".artCard").forEach((card) => frag2.appendChild(card.cloneNode(true)));

    row1.appendChild(frag1);
    row2.appendChild(frag2);

  } catch (err) {
    console.error(err);
  }
}

function startHorizontalMarquee() {
  if (!marqueeEl || !trackEl || !row1 || !row2) return;

  let x = 0;
  let last = performance.now();
  let paused = false;

  const speed = 35;

  marqueeEl.addEventListener("mouseenter", () => (paused = true));
  marqueeEl.addEventListener("mouseleave", () => (paused = false));

  function step(now) {
    const dt = (now - last) / 1000;
    last = now;

    if (!paused && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      x += speed * dt;
      trackEl.style.transform = `translateX(${-x}px)`;
    }

    const viewportW = marqueeEl.clientWidth;
    const trackW = Math.max(row1.scrollWidth, row2.scrollWidth);

    if (trackW - x < viewportW * 2.5) {
      if (!trackEl.dataset.repeating) {
        trackEl.dataset.repeating = "1";
        repeatMarquee();
        setTimeout(() => delete trackEl.dataset.repeating, 200);
      }
    }
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

/* =========================
   Init
========================= */
async function init() {
  // 1) Marquee mode takes over the page if enabled
  if (window.MARQUEE_MODE && marqueeEl && trackEl && row1 && row2) {
    const first = Number(window.MARQUEE_BATCH ?? 200);

    await repeatMarquee(first);
    startHorizontalMarquee();
    return;
  }

  // 2) Normal gallery mode (grid)
  const limit = Number(window.GALLERY_LIMIT ?? 40);
  const randomize = Boolean(window.GALLERY_RANDOM ?? false);
  if (galleryEl) await loadGallery(limit, randomize);

  // 3) Canvas page stuff
  if (canvas) {
    ctx = canvas.getContext("2d", { willReadFrequently: true });

    canvas.addEventListener("pointerdown", startDraw);
    canvas.addEventListener("pointermove", draw);
    canvas.addEventListener("pointerup", endDraw);
    canvas.addEventListener("pointercancel", endDraw);
    canvas.addEventListener("pointerleave", endDraw);

    initColorWheel();
    applyPencilCursor();
    clearCanvas();
  }

  submitBtn?.addEventListener("click", submitDrawing);
  clearBtn?.addEventListener("click", clearCanvas);

  // Optional globals
  window.loadGallery = loadGallery;
  window.submitDrawing = submitDrawing;
  window.clearCanvas = clearCanvas;
}

init().catch((err) => {
  console.error(err);
});
