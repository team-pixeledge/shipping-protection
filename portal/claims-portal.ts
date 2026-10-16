// Browser script for the storefront claims page (app/lib/portal-pages.ts),
// bundled to public/claims-portal.js by scripts/build-portal.mjs and served
// from the app's own domain. Uploads evidence straight to the private Blob
// store with a client token from /apps/<subpath>/upload, then adds a hidden
// "files" input per upload; the server re-checks every file on submit.
import { upload } from "@vercel/blob/client";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 8;

function setupUploads(box: HTMLElement) {
  const input = box.querySelector<HTMLInputElement>('input[type="file"]');
  const list = box.querySelector<HTMLElement>(".sp-files");
  const form = box.closest("form");
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const { token = "", prefix = "", endpoint = "" } = box.dataset;
  if (!input || !list || !form || !submit) return;

  let pending = 0;
  let count = 0;

  const row = (text: string) => {
    const el = document.createElement("div");
    el.className = "sp-muted";
    el.textContent = text;
    list.appendChild(el);
    return el;
  };

  input.addEventListener("change", async () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    for (const file of files) {
      if (count >= MAX_FILES) {
        row(`${file.name}: too many files (${MAX_FILES} at most)`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        row(`${file.name}: too large (10 MB at most)`);
        continue;
      }
      count++;
      pending++;
      submit.disabled = true;
      const status = row(`Uploading ${file.name}…`);
      try {
        const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
        const blob = await upload(prefix + safe, file, {
          access: "private",
          handleUploadUrl: endpoint,
          clientPayload: token,
          ...(file.type ? { contentType: file.type } : {}),
        });
        const hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.name = "files";
        hidden.value = JSON.stringify({ pathname: blob.pathname, name: file.name.slice(0, 120) });
        form.appendChild(hidden);
        status.textContent = `✓ ${file.name}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.style.cssText = "margin-left:.6rem;padding:.1rem .5rem;background:none;color:inherit;border:1px solid currentColor;";
        remove.addEventListener("click", () => {
          hidden.remove();
          status.remove();
          count--;
        });
        status.appendChild(remove);
      } catch {
        count--;
        status.textContent = `✗ ${file.name}: upload failed — try again`;
      } finally {
        pending--;
        if (!pending) submit.disabled = false;
      }
    }
  });

  form.addEventListener("submit", (e) => {
    if (pending) e.preventDefault();
  });
}

function init() {
  const root = document.querySelector<HTMLElement>(".sp-claims");
  // After a POST the page shows the result; point the address bar at the
  // GET version so a refresh doesn't resubmit.
  const replace = root?.dataset.spReplaceUrl;
  if (replace) history.replaceState(null, "", replace);

  document.querySelectorAll<HTMLElement>("[data-sp-upload]").forEach(setupUploads);
  // One submit per form: a double click mustn't file two claims.
  document.querySelectorAll<HTMLFormElement>("[data-sp-claim-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      if (e.defaultPrevented) return;
      if (form.dataset.sent) return e.preventDefault();
      form.dataset.sent = "1";
      form.querySelector<HTMLButtonElement>('button[type="submit"]')?.setAttribute("disabled", "");
    });
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
