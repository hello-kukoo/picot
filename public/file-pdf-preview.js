/**
 * PDF.js canvas renderer.
 *
 * Renders PDF pages into canvas elements inside a scrollable container.
 * The worker is configured to use the same-origin vendor bundle.
 * At runtime, the browser import map redirects pdfjs-dist/legacy/build/pdf.mjs
 * to the generated vendor file. In Vitest, the import resolves from node_modules.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Configure the worker to use the same-origin vendor bundle.
// This URL is only used in the browser (not in Vitest).
if (typeof window !== "undefined" && GlobalWorkerOptions) {
  GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.js";
}

export function createPdfRenderer({ filePath, onError }) {
  let container = null;
  let pdfDoc = null;
  let renderTask = null;
  let _rendering = false;

  async function loadDocument() {
    if (!container) return;
    _rendering = true;
    try {
      const url = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
      const loadingTask = getDocument({ url });
      pdfDoc = await loadingTask.promise;

      if (!container) return; // destroyed during load

      const numPages = pdfDoc.numPages;
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        if (!container) return;
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });

        const canvas = document.createElement("canvas");
        canvas.className = "file-pdf-page";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        container.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        renderTask = null;
      }
    } catch (err) {
      if (typeof onError === "function") {
        onError(err);
      }
    } finally {
      _rendering = false;
    }
  }

  return {
    mount(parent) {
      container = document.createElement("div");
      container.className = "file-pdf-container";
      parent.appendChild(container);
      void loadDocument();
    },

    update() {
      // PDF preview has no props to update.
    },

    destroy() {
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
        renderTask = null;
      }
      pdfDoc = null;
      if (container?.parentNode) {
        container.parentNode.removeChild(container);
      }
      container = null;
    },
  };
}
