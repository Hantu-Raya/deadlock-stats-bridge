// Status reporting shared by the chart pages. Panorama reads only document.title (and the URL hash),
// so every outcome is published as PREFIX + JSON({v, ...payload}).
import { ApiError } from "./api.js?v=20261019-8";

export function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function errorCode(error) {
  if (error?.code === "invalid_payload") return "invalid_payload";
  if (error instanceof ApiError || error?.name === "ApiError") {
    if (error.status === 429) return "rate_limit";
    if (Number.isInteger(error.status) && error.status > 0) return "upstream_error";
  }
  return "network_error";
}

export function createStatus(prefix, version) {
  return {
    publish(payload, documentRef, locationRef) {
      const title = prefix + JSON.stringify({ v: version, ...payload });
      try {
        documentRef.title = title;
        if (locationRef) locationRef.hash = encodeURIComponent(title);
      } catch {
        /* page is unloading */
      }
    },
    showMessage(documentRef, text) {
      try {
        documentRef.body.innerHTML = `<p class="message">${escapeText(text)}</p>`;
      } catch {
        /* page is unloading */
      }
    },
  };
}

// Runs the page in a browser; run receives the AbortSignal that pagehide aborts.
export function startPage(run) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  window.addEventListener?.("pagehide", () => controller?.abort(), { once: true });
  void run(controller?.signal);
}
