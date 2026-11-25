const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../app.js");

const ROOT_DIR = path.resolve(__dirname, "..");

function mapOverlayVisualPointToUnrotatedPdf(u, v, placement) {
  const rad = (placement.rotateDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = u * placement.width;
  const ly = (1 - v) * placement.height;
  return {
    x: placement.x + lx * cos - ly * sin,
    y: placement.y + lx * sin + ly * cos,
  };
}

function unrotatedPdfToViewerVisualNormalized(pdfX, pdfY, pageWidth, pageHeight, rotationAngle, ox = 0, oy = 0) {
  const rx = pdfX - ox;
  const ry = pdfY - oy;
  const rot = app.normalizeRotationDegrees(rotationAngle);
  if (rot === 0) {
    return { u: rx / pageWidth, v: 1 - ry / pageHeight };
  }
  if (rot === 90) {
    return { u: ry / pageHeight, v: rx / pageWidth };
  }
  if (rot === 180) {
    return { u: 1 - rx / pageWidth, v: ry / pageHeight };
  }
  // 270 CW (90 CCW)
  return { u: 1 - ry / pageHeight, v: 1 - rx / pageWidth };
}

test("security headers and CDN script pinning", () => {
  const headers = fs.readFileSync(path.join(ROOT_DIR, "_headers"), "utf8");
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy:\s*strict-origin-when-cross-origin/);
  assert.match(headers, /Permissions-Policy:/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(headers, /worker-src 'self' blob: https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(headers, /img-src 'self' data: blob:/);
  assert.match(headers, /style-src 'self' 'unsafe-inline'/);
  assert.match(headers, /connect-src 'self' https:\/\/cdnjs\.cloudflare\.com blob: data:/);

  const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
  assert.match(
    html,
    /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\/pdf\.min\.js" crossorigin="anonymous"/
  );
  assert.match(
    html,
    /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf-lib\/1\.17\.1\/pdf-lib\.min\.js" crossorigin="anonymous"/
  );
  assert.doesNotMatch(html, /integrity=/i, "must not fabricate offline SRI hashes");
});

test("computePageDrawBox scales cleanly on narrow mobile and landscape stages", () => {
  // Narrow mobile stage (280x380) with A4 portrait document
  const mobileBox = app.computePageDrawBox(280, 380, 595, 842);
  assert.ok(mobileBox.width <= 280 && mobileBox.height <= 380);
  assert.ok(Math.abs(mobileBox.width / mobileBox.height - 595 / 842) < 1e-3);
  assert.ok(mobileBox.x >= 0 && mobileBox.y >= 0);

  // Wide landscape document in portrait stage
  const landscapeInPortrait = app.computePageDrawBox(400, 600, 1600, 900);
  assert.equal(landscapeInPortrait.width, 400);
  assert.equal(landscapeInPortrait.height, 225);
  assert.equal(landscapeInPortrait.x, 0);
  assert.equal(landscapeInPortrait.y, 187.5);
});

test("normalized coordinates stay invariant across window resizes and aspect changes", () => {
  const desktopBox = app.computePageDrawBox(900, 600, 595, 842);
  const mobileBox = app.computePageDrawBox(300, 500, 595, 842);

  // User clicks at 75% across, 82% down the desktop rendered page
  const clickX = desktopBox.x + 0.75 * desktopBox.width;
  const clickY = desktopBox.y + 0.82 * desktopBox.height;

  const norm = app.stagePointToPageNormalized(clickX, clickY, desktopBox);
  assert.ok(Math.abs(norm.x - 0.75) < 1e-9);
  assert.ok(Math.abs(norm.y - 0.82) < 1e-9);

  // Re-projected onto resized mobile stage
  const mobilePt = app.pageNormalizedToStagePoint(norm.x, norm.y, mobileBox);
  assert.ok(Math.abs((mobilePt.x - mobileBox.x) / mobileBox.width - 0.75) < 1e-9);
  assert.ok(Math.abs((mobilePt.y - mobileBox.y) / mobileBox.height - 0.82) < 1e-9);

  // Stroke line width scales proportionally to page width
  const stroke = { color: "#101820", size: 4, refWidth: desktopBox.width, points: [norm] };
  const mobileStrokeWidth = app.computeStrokeLineWidth(stroke, mobileBox.width);
  assert.ok(Math.abs(mobileStrokeWidth - 4 * (mobileBox.width / desktopBox.width)) < 1e-9);
});

test("computeSignatureImageBox preserves aspect ratio relative to pageDrawBox", () => {
  const landscapePage = { x: 0, y: 50, width: 800, height: 400 };
  const placed = app.computeSignatureImageBox(app.INITIAL_SIGNATURE_BOX, landscapePage, 400, 100);
  const renderedWidth = placed.width * landscapePage.width;
  const renderedHeight = placed.height * landscapePage.height;
  assert.ok(Math.abs(renderedWidth / renderedHeight - 4) < 1e-6);
});

test("computeSignatureBounds handles single-tap dots and huge point arrays safely", () => {
  const dotBounds = app.computeSignatureBounds([{ points: [{ x: 0.4, y: 0.6 }] }], null, 0);
  assert.deepEqual(dotBounds, { minX: 0.4, minY: 0.6, maxX: 0.4, maxY: 0.6 });

  const manyPoints = Array.from({ length: 120000 }, (_, i) => ({
    x: 0.1 + (i / 120000) * 0.5,
    y: 0.2 + ((i % 100) / 100) * 0.3,
  }));
  const largeBounds = app.computeSignatureBounds([{ points: manyPoints }], null, 0);
  assert.ok(Math.abs(largeBounds.minX - 0.1) < 1e-6);
  assert.ok(Math.abs(largeBounds.maxX - 0.6) < 1e-4);
});

test("computeMoveHandleStagePosition stays inside narrow stage bounds", () => {
  const pageBox = { x: 0, y: 0, width: 260, height: 360 };
  const bounds = { minX: 0.01, minY: 0.01, maxX: 0.2, maxY: 0.1 };
  const pos = app.computeMoveHandleStagePosition(bounds, pageBox, 260, 360);
  assert.ok(pos.x >= 20 && pos.x <= 240);
  assert.ok(pos.y >= 15 && pos.y <= 345);
  assert.ok(pos.leftPercent >= 0 && pos.leftPercent <= 100);
  assert.ok(pos.topPercent >= 0 && pos.topPercent <= 100);
});

test("computePdfOverlayPlacement maps visual signature points accurately for all /Rotate angles", () => {
  const pageWidth = 595;
  const pageHeight = 842;
  const testAngles = [0, 90, 180, 270, -90, 450];
  const samplePoints = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 0, v: 1 },
    { u: 1, v: 1 },
    { u: 0.17, v: 0.73 },
    { u: 0.82, v: 0.24 },
  ];

  for (const angle of testAngles) {
    for (const [ox, oy] of [
      [0, 0],
      [20, 35],
    ]) {
      const placement = app.computePdfOverlayPlacement(pageWidth, pageHeight, angle, ox, oy);
      for (const { u, v } of samplePoints) {
        const pdfPt = mapOverlayVisualPointToUnrotatedPdf(u, v, placement);
        const viewerVisual = unrotatedPdfToViewerVisualNormalized(
          pdfPt.x,
          pdfPt.y,
          pageWidth,
          pageHeight,
          angle,
          ox,
          oy
        );
        assert.ok(
          Math.abs(viewerVisual.u - u) < 1e-9 && Math.abs(viewerVisual.v - v) < 1e-9,
          `mismatch for angle=${angle} origin=(${ox},${oy}) point=(${u},${v}): got (${viewerVisual.u},${viewerVisual.v})`
        );
      }
    }
  }
});

test("buildSignedPdfBytes embeds 2x+ DPR overlays with rotation-aware drawImage params", async () => {
  const drawCalls = [];
  const overlayRequests = [];

  const makeMockPage = (width, height, angle) => ({
    getSize: () => ({ width, height }),
    getCropBox: () => ({ x: 0, y: 0, width, height }),
    getRotation: () => ({ angle }),
    drawImage: (img, opts) => drawCalls.push({ img, opts }),
  });

  const mockPages = [
    makeMockPage(595, 842, 0),
    makeMockPage(595, 842, 90),
    makeMockPage(595, 842, 270),
  ];

  const mockPDFLib = {
    degrees: (deg) => ({ type: "degrees", angle: deg }),
    PDFDocument: {
      load: async () => ({
        getPages: () => mockPages,
        embedPng: async (buf) => ({ embeddedLen: buf.byteLength }),
        save: async () => new Uint8Array([37, 80, 68, 70]),
      }),
    },
  };

  const pdfSignatures = new Map([
    ["page-2", [{ color: "#101820", size: 4, refWidth: 842, points: [{ x: 0.5, y: 0.5 }] }]],
    ["page-3", [{ color: "#0f5c66", size: 3, refWidth: 842, points: [{ x: 0.2, y: 0.8 }] }]],
  ]);

  const saved = await app.buildSignedPdfBytes({
    pdfBytes: new Uint8Array([1, 2, 3]).buffer,
    pdfSignatures,
    pdfSignatureImages: new Map(),
    PDFLibRef: mockPDFLib,
    devicePixelRatio: 1,
    renderOverlayPngBytes: async (req) => {
      overlayRequests.push(req);
      return new Uint8Array([137, 80, 78, 71]).buffer;
    },
  });

  assert.equal(saved.byteLength, 4);
  assert.equal(drawCalls.length, 2, "unsigned page 1 should be skipped");
  assert.equal(overlayRequests[0].exportScale, 2, "should upgrade 1x DPR to 2x crisp export");
  assert.equal(overlayRequests[0].visualWidth, 842);
  assert.equal(overlayRequests[0].visualHeight, 595);

  assert.deepEqual(drawCalls[0].opts, {
    x: 595,
    y: 0,
    width: 842,
    height: 595,
    rotate: { type: "degrees", angle: 90 },
  });
  assert.deepEqual(drawCalls[1].opts, {
    x: 0,
    y: 842,
    width: 842,
    height: 595,
    rotate: { type: "degrees", angle: 270 },
  });
});

test("validateUploadFile enforces file size limits and formats", () => {
  assert.equal(app.validateUploadFile(null, "document").ok, false);
  assert.equal(app.validateUploadFile({ name: "empty.pdf", type: "application/pdf", size: 0 }, "document").ok, false);
  assert.equal(
    app.validateUploadFile({ name: "huge.pdf", type: "application/pdf", size: app.MAX_PDF_BYTES + 1 }, "document").ok,
    false
  );
  assert.equal(
    app.validateUploadFile({ name: "ok.pdf", type: "application/pdf", size: 1024 }, "document").kind,
    "pdf"
  );
  assert.equal(
    app.validateUploadFile({ name: "huge.png", type: "image/png", size: app.MAX_IMAGE_BYTES + 1 }, "document").ok,
    false
  );
  assert.equal(
    app.validateUploadFile({ name: "scan.webp", type: "image/webp", size: 4096 }, "document").kind,
    "image"
  );
  assert.equal(
    app.validateUploadFile({ name: "malware.exe", type: "application/octet-stream", size: 100 }, "document").ok,
    false
  );
  assert.equal(
    app.validateUploadFile({ name: "contract.pdf", type: "application/pdf", size: 500 }, "signature").ok,
    false
  );
  assert.equal(
    app.validateUploadFile({ name: "sig.png", type: "image/png", size: 500 }, "signature").ok,
    true
  );
});

test("atomic PDF loading, renderToken staleness guard, single-tap dot, and export lock", async () => {
  // Build a minimal DOM mock to run initSignatureApp end-to-end in Node
  const listeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : force ? set.add(c) : set.delete(c)),
      contains: (c) => set.has(c),
    };
  };

  const makeCtx = () => {
    const ops = [];
    return {
      ops,
      setTransform: () => {},
      clearRect: (...args) => ops.push(["clearRect", ...args]),
      drawImage: (...args) => ops.push(["drawImage", ...args]),
      beginPath: () => ops.push(["beginPath"]),
      arc: (...args) => ops.push(["arc", ...args]),
      fill: () => ops.push(["fill"]),
      moveTo: (...args) => ops.push(["moveTo", ...args]),
      quadraticCurveTo: (...args) => ops.push(["quadraticCurveTo", ...args]),
      lineTo: (...args) => ops.push(["lineTo", ...args]),
      stroke: () => ops.push(["stroke"]),
      save: () => {},
      restore: () => {},
      rect: () => {},
      clip: () => {},
      fillRect: () => {},
    };
  };

  const makeEl = (id, extra = {}) => {
    const elListeners = new Map();
    const attrs = new Map();
    const styles = new Map();
    const el = {
      id,
      value: "",
      disabled: false,
      textContent: "",
      width: 300,
      height: 400,
      classList: makeClassList(extra.classes),
      style: {
        setProperty: (k, v) => styles.set(k, v),
        getPropertyValue: (k) => styles.get(k) || "",
        removeProperty: (k) => styles.delete(k),
      },
      dataset: extra.dataset || {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: extra.rectW || 300, height: extra.rectH || 400 }),
      addEventListener: (type, fn) => {
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      dispatch: (type, ev) => {
        for (const fn of elListeners.get(type) || []) fn(ev);
      },
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: (k) => attrs.get(k),
      removeAttribute: (k) => attrs.delete(k),
      setPointerCapture: () => {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
      getContext: () => extra.ctx || makeCtx(),
      toBlob: (cb) => cb({ arrayBuffer: async () => new Uint8Array([1, 2]).buffer }),
      click: () => {},
    };
    return el;
  };

  const docCtx = makeCtx();
  const signCtx = makeCtx();
  const elements = new Map([
    ["documentCanvas", makeEl("documentCanvas", { ctx: docCtx })],
    ["signatureCanvas", makeEl("signatureCanvas", { ctx: signCtx })],
    ["documentInput", makeEl("documentInput")],
    ["documentDropZone", makeEl("documentDropZone")],
    ["signatureImportZone", makeEl("signatureImportZone")],
    ["documentName", makeEl("documentName")],
    ["inkColor", makeEl("inkColor")],
    ["inkSize", makeEl("inkSize")],
    ["undoBtn", makeEl("undoBtn")],
    ["redoBtn", makeEl("redoBtn")],
    ["clearBtn", makeEl("clearBtn")],
    ["fitBtn", makeEl("fitBtn")],
    ["downloadSignatureBtn", makeEl("downloadSignatureBtn")],
    ["signatureImportInput", makeEl("signatureImportInput")],
    ["downloadDocumentBtn", makeEl("downloadDocumentBtn")],
    ["signatureMoveHandle", makeEl("signatureMoveHandle", { classes: ["hidden"] })],
    ["strokeStatus", makeEl("strokeStatus")],
    ["appNotice", makeEl("appNotice", { classes: ["hidden"] })],
    ["pageControls", makeEl("pageControls", { classes: ["hidden"] })],
    ["pageIndicator", makeEl("pageIndicator")],
    ["prevPageBtn", makeEl("prevPageBtn")],
    ["nextPageBtn", makeEl("nextPageBtn")],
  ]);
  elements.get("inkColor").value = "#101820";
  elements.get("inkSize").value = "4";
  const stageEl = makeEl("documentStage", { rectW: 300, rectH: 400 });

  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevPdfjs = global.pdfjsLib;
  const prevUrl = global.URL;

  try {
    let page2Resolve;
    const page2RenderPromise = new Promise((r) => {
      page2Resolve = r;
    });
    const renderedPages = [];
    let shouldFailPdf = false;
    let exportCalls = 0;
    let releaseExport;

    const mockPdfDoc = {
      numPages: 3,
      destroy: () => {},
      getPage: async (pageNum) => ({
        getViewport: ({ scale }) =>
          pageNum === 2
            ? { width: 842 * scale, height: 595 * scale }
            : { width: 595 * scale, height: 842 * scale },
        render: () => ({
          cancel: () => {},
          promise:
            pageNum === 2
              ? page2RenderPromise.then(() => renderedPages.push(2))
              : Promise.resolve().then(() => renderedPages.push(pageNum)),
        }),
      }),
    };

    global.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: shouldFailPdf ? Promise.reject(new Error("Corrupt PDF")) : Promise.resolve(mockPdfDoc),
      }),
    };

    global.window = {
      devicePixelRatio: 2,
      pdfjsLib: global.pdfjsLib,
      PDFLib: {
        degrees: (a) => a,
        PDFDocument: {
          load: async () => {
            exportCalls += 1;
            await new Promise((r) => {
              releaseExport = r;
            });
            return {
              getPages: () => [],
              save: async () => new Uint8Array([37, 80, 68, 70]),
            };
          },
        },
      },
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    };

    global.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".document-stage" ? stageEl : null),
      querySelectorAll: () => [],
      createElement: () => makeEl("dynamic"),
    };
    global.URL = {
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    };

    const controller = app.initSignatureApp();
    assert.ok(controller);

    // 1. Single-tap dot draws arc+fill and commits stroke; second pointerId is ignored
    const sigCanvas = elements.get("signatureCanvas");
    sigCanvas.dispatch("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 150,
      clientY: 200,
      preventDefault: () => {},
    });
    // Multi-touch second finger should be ignored
    sigCanvas.dispatch("pointermove", {
      pointerId: 2,
      clientX: 20,
      clientY: 20,
      preventDefault: () => {},
    });
    sigCanvas.dispatch("pointerup", {
      pointerId: 1,
      type: "pointerup",
      preventDefault: () => {},
    });
    assert.equal(controller.state.strokes.length, 1);
    assert.equal(controller.state.strokes[0].points.length, 1);
    assert.ok(signCtx.ops.some((op) => op[0] === "arc"));

    // 2. Load valid PDF
    await controller.loadPdfDocument({
      name: "good.pdf",
      type: "application/pdf",
      size: 1024,
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    });
    assert.equal(controller.state.mode, "pdf");
    assert.equal(controller.state.pdfPageCount, 3);
    assert.equal(elements.get("documentName").textContent, "good.pdf");

    // 3. Corrupt PDF must NOT wipe current open PDF!
    shouldFailPdf = true;
    await controller.loadPdfDocument({
      name: "corrupt.pdf",
      type: "application/pdf",
      size: 512,
      arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer,
    });
    assert.equal(controller.state.mode, "pdf");
    assert.equal(controller.state.pdfPageCount, 3);
    assert.equal(elements.get("documentName").textContent, "good.pdf");
    assert.equal(elements.get("appNotice").classList.contains("hidden"), false);

    // 4. Rapid goToPdfPage(2) then goToPdfPage(3): stale page 2 render must NOT draw over page 3
    docCtx.ops.length = 0;
    const nav2 = controller.goToPdfPage(2);
    const nav3 = controller.goToPdfPage(3);
    await nav3;
    const drawCountAfterPage3 = docCtx.ops.filter((op) => op[0] === "drawImage").length;
    page2Resolve();
    await nav2;
    const drawCountAfterStalePage2 = docCtx.ops.filter((op) => op[0] === "drawImage").length;
    assert.equal(controller.state.pdfPage, 3);
    assert.equal(drawCountAfterStalePage2, drawCountAfterPage3, "stale page 2 render must not overwrite page 3");

    // 5. Corrupt image must NOT wipe current open PDF!
    const prevFileReader = global.FileReader;
    const prevImage = global.Image;
    try {
      global.FileReader = class MockFileReader {
        readAsDataURL() {
          this.result = "data:image/png;base64,corrupt";
          setTimeout(() => this.onload?.(), 0);
        }
      };
      global.Image = class MockBrokenImage {
        set src(_value) {
          setTimeout(() => this.onerror?.(), 0);
        }
      };

      await controller.loadImageDocument({
        name: "broken.png",
        type: "image/png",
        size: 256,
      });
      assert.equal(controller.state.mode, "pdf", "corrupt image must not wipe open PDF");
      assert.equal(elements.get("documentName").textContent, "good.pdf");
      assert.equal(elements.get("appNotice").classList.contains("hidden"), false);
    } finally {
      global.FileReader = prevFileReader;
      global.Image = prevImage;
    }

    // 6. Drag-and-drop zone highlights and drops file
    const dropZone = elements.get("documentDropZone");
    let dragDefaultPrevented = false;
    dropZone.dispatch("dragenter", { preventDefault: () => (dragDefaultPrevented = true) });
    assert.equal(dragDefaultPrevented, true);
    assert.equal(dropZone.classList.contains("is-dragover"), true);
    dropZone.dispatch("dragleave", { preventDefault: () => {} });
    assert.equal(dropZone.classList.contains("is-dragover"), false);

    // 7. Ctrl/Cmd+Z undo and Ctrl/Cmd+Shift+Z redo keyboard shortcuts
    sigCanvas.dispatch("pointerdown", {
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 120,
      preventDefault: () => {},
    });
    sigCanvas.dispatch("pointerup", {
      pointerId: 7,
      type: "pointerup",
      preventDefault: () => {},
    });
    assert.equal(controller.state.strokes.length, 1);

    const keydownHandlers = listeners.get("keydown") || [];
    for (const fn of keydownHandlers) {
      fn({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "z", preventDefault: () => {} });
    }
    assert.equal(controller.state.strokes.length, 0);
    assert.equal(controller.state.redo.length, 1);

    for (const fn of keydownHandlers) {
      fn({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "Z", preventDefault: () => {} });
    }
    assert.equal(controller.state.strokes.length, 1);
    assert.equal(controller.state.redo.length, 0);

    // 8. isExporting re-entrancy lock prevents concurrent exports
    const firstExport = controller.exportDocument();
    const secondExport = controller.exportDocument();
    assert.equal(controller.state.isExporting, true);
    assert.equal(elements.get("downloadDocumentBtn").disabled, true);
    assert.equal(elements.get("downloadDocumentBtn").getAttribute("aria-busy"), "true");
    releaseExport();
    await Promise.all([firstExport, secondExport]);
    assert.equal(exportCalls, 1);
    assert.equal(controller.state.isExporting, false);
    assert.equal(elements.get("downloadDocumentBtn").disabled, false);
  } finally {
    global.window = prevWindow;
    global.document = prevDocument;
    global.pdfjsLib = prevPdfjs;
    global.URL = prevUrl;
  }
});
