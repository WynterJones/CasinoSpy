// Thin client for the PixelLab AI v2 API (https://api.pixellab.ai/v2/docs).
// Powers the pixel-art buddy: generate character options, turn a chosen sprite
// into a reusable character, and animate it into idle/win/lose clips.
//
// Image payloads are base64 PNG data URIs. Simple image generation is
// synchronous; character creation and animation are async background jobs that
// we poll until completion. Animation frames come back as raw `rgba_bytes` and
// must be re-encoded to PNG via canvas before use.

const BASE_URL = "https://api.pixellab.ai/v2";

export class PixelLabError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PixelLabError";
    this.status = status;
    this.code =
      status === 401 ? "auth"
      : status === 402 ? "credits"
      : status === 422 ? "validation"
      : status === 429 || status === 529 ? "rate_limit"
      : status >= 500 ? "server"
      : "unknown";
  }
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };
}

async function request(apiKey, path, init) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...authHeaders(apiKey), ...((init && init.headers) || {}) },
    });
  } catch (e) {
    throw new PixelLabError(0, `Network error contacting PixelLab: ${String(e)}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail =
        (body && body.detail && (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail))) ||
        (body && body.message) ||
        detail;
    } catch { /* non-JSON error body */ }
    throw new PixelLabError(res.status, detail);
  }
  return res.json();
}

function extractBase64(image) {
  if (!image) return null;
  if (typeof image === "string") return image;
  if (typeof image === "object") {
    if (typeof image.base64 === "string") return image.base64;
    if (typeof image.image === "object") return extractBase64(image.image);
  }
  return null;
}

export function toDataUri(base64) {
  return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Re-encode a raw RGBA buffer (PixelLab animation frame) into a PNG data URI.
function rgbaBytesToPngDataUri(base64, width, height) {
  const bytes = base64ToBytes(base64);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PixelLabError(0, "Canvas 2D context unavailable for frame encoding");
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(bytes.subarray(0, imageData.data.length));
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function isFrameImage(o) {
  return !!o && typeof o === "object" && typeof o.base64 === "string";
}

function imageToDataUri(img) {
  if (!img.base64) return null;
  if (img.type === "rgba_bytes" && img.width && img.height) {
    return rgbaBytesToPngDataUri(img.base64, img.width, img.height);
  }
  return toDataUri(img.base64);
}

// ---- balance / key validation ----
export async function getBalance(apiKey) {
  const data = await request(apiKey, "/balance", { method: "GET" });
  return {
    usd: (data && data.credits && data.credits.usd) ?? (data && data.usd),
    generations: data && data.subscription && data.subscription.generations,
    plan: data && data.subscription && data.subscription.plan,
  };
}

// ---- step 1: generate pixel-art image options from text ----
export async function createPixelImage(apiKey, { description, size = { width: 64, height: 64 }, noBackground = true }) {
  const data = await request(apiKey, "/create-image-pixflux", {
    method: "POST",
    body: JSON.stringify({ description, image_size: size, no_background: noBackground }),
  });
  const b64 = extractBase64(data && data.image);
  if (!b64) throw new PixelLabError(0, "PixelLab returned no image data");
  return toDataUri(b64);
}

export async function createPixelImageOptions(apiKey, opts, count = 3) {
  const results = await Promise.allSettled(
    Array.from({ length: count }, () => createPixelImage(apiKey, opts))
  );
  const images = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (images.length === 0) {
    const firstReject = results.find((r) => r.status === "rejected");
    throw (firstReject && firstReject.reason) || new PixelLabError(0, "All image generations failed");
  }
  return images;
}

// ---- step 2: create a reusable character from the chosen sprite ----
export async function createCharacter(apiKey, { description, referenceImage, size = { width: 64, height: 64 } }) {
  const body = { description, image_size: size };
  if (referenceImage) body.reference_image = { base64: referenceImage };
  const data = await request(apiKey, "/create-character-v3", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const jobId = (data && data.background_job_id) || (data && data.job_id);
  if (!jobId) throw new PixelLabError(0, "PixelLab returned no background job id");
  return { jobId, characterId: data && data.character_id };
}

// ---- step 3: animate a character into a clip ----
export async function animateCharacter(apiKey, { characterId, action, frameCount = 4, directions = ["south"] }) {
  const data = await request(apiKey, "/animate-character", {
    method: "POST",
    body: JSON.stringify({
      character_id: characterId,
      mode: "v3",
      action_description: action,
      frame_count: frameCount,
      directions,
    }),
  });
  const ids = (data && data.background_job_ids) || (data && data.background_job_id ? [data.background_job_id] : []);
  if (ids.length === 0) throw new PixelLabError(0, "PixelLab returned no animation jobs");
  return ids;
}

// ---- background job polling ----
function collectFrames(response) {
  let imagesArray = null;
  const findImages = (node) => {
    if (imagesArray || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every(isFrameImage)) { imagesArray = node; return; }
      node.forEach(findImages);
      return;
    }
    if (Array.isArray(node.images) && node.images.length > 0 && node.images.every(isFrameImage)) {
      imagesArray = node.images;
      return;
    }
    Object.values(node).forEach(findImages);
  };
  findImages(response);
  if (imagesArray) {
    return imagesArray.map(imageToDataUri).filter(Boolean);
  }
  // fallback: walk for a single base64 PNG image
  const frames = [];
  const visit = (node) => {
    if (!node) return;
    if (typeof node === "object") {
      const b64 = extractBase64(node);
      if (b64) { frames.push(toDataUri(b64)); return; }
      if (Array.isArray(node)) node.forEach(visit);
      else Object.values(node).forEach(visit);
    }
  };
  visit(response);
  return frames;
}

export async function pollJob(apiKey, jobId, { signal, onProgress, maxAttempts = 120 } = {}) {
  let delay = 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal && signal.aborted) throw new PixelLabError(0, "Cancelled");
    let data;
    try {
      data = await request(apiKey, `/background-jobs/${jobId}`, { method: "GET", signal });
    } catch (e) {
      if (e instanceof PixelLabError && e.code === "rate_limit") {
        delay = Math.min(delay * 2, 10000);
        await sleep(delay, signal);
        continue;
      }
      throw e;
    }
    const status = String((data && data.status) || "processing").toLowerCase();
    if (onProgress) onProgress(status);
    if (status === "completed" || status === "success" || status === "done") {
      return collectFrames((data && data.last_response) || (data && data.result) || data);
    }
    if (status === "failed" || status === "error") {
      throw new PixelLabError(0, (data && data.error) || "PixelLab job failed");
    }
    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.25), 6000);
  }
  throw new PixelLabError(0, "Timed out waiting for PixelLab job");
}

export async function animateAndCollect(apiKey, opts, poll) {
  const jobIds = await animateCharacter(apiKey, opts);
  const perJob = await Promise.all(jobIds.map((id) => pollJob(apiKey, id, poll)));
  return perJob.flat();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new PixelLabError(0, "Cancelled")); }, { once: true });
    }
  });
}

// Human-friendly message for a thrown error.
export function pixelLabErrorMessage(e) {
  if (e instanceof PixelLabError) {
    switch (e.code) {
      case "auth": return "Invalid API key — check your PixelLab key and try again.";
      case "credits": return "Not enough PixelLab credits for this request.";
      case "rate_limit": return "PixelLab is rate-limiting requests — wait a moment and retry.";
      default: return e.message || "PixelLab request failed.";
    }
  }
  return e instanceof Error ? e.message : String(e);
}
