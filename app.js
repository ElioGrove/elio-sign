const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_EXPORT_DIMENSION = 4096;
const RESIZE_DEBOUNCE_MS = 120;
const PDF_WORKER_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".avif"];

const INITIAL_SIGNATURE_BOX = {
  x: 0.52,
  y: 0.78,
  width: 0.4,
  height: 0.12,
};

function clamp(value, min, max) {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function stabilizePoint(previous, point, amount = 0.38) {
  if (!previous) return point;
  return {
    x: previous.x + (point.x - previous.x) * amount,
    y: previous.y + (point.y - previous.y) * amount,
    pressure: point.pressure,
  };
}

function cloneInk(strokes) {
  return strokes.map((stroke) => ({
    color: stroke.color,
    size: stroke.size,
    refWidth: stroke.refWidth,
    points: stroke.points.map((point) => ({ ...point })),
  }));
}

function cloneSignatureImage(signatureImage) {
  if (!signatureImage) return null;
  return { ...signatureImage };
}

function normalizeRotationDegrees(angle) {
  const numeric = Number(angle);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((Math.round(numeric / 90) * 90) % 360 + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function computePageDrawBox(stageWidth, stageHeight, contentWidth, contentHeight) {
  const safeStageWidth = Math.max(1, Number(stageWidth) || 1);
  const safeStageHeight = Math.max(1, Number(stageHeight) || 1);
  const safeContentWidth = Number(contentWidth);
  const safeContentHeight = Number(contentHeight);

  if (!Number.isFinite(safeContentWidth) || !Number.isFinite(safeContentHeight) || safeContentWidth <= 0 || safeContentHeight <= 0) {
    return { x: 0, y: 0, width: safeStageWidth, height: safeStageHeight };
  }

  const scale = Math.min(safeStageWidth / safeContentWidth, safeStageHeight / safeContentHeight);
  const drawWidth = Math.max(1, safeContentWidth * scale);
  const drawHeight = Math.max(1, safeContentHeight * scale);
  return {
    x: (safeStageWidth - drawWidth) / 2,
    y: (safeStageHeight - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

function stagePointToPageNormalized(stageX, stageY, pageBox, options = {}) {
  const { clampToPage = true } = options;
  const width = Math.max(1e-6, pageBox.width);
  const height = Math.max(1e-6, pageBox.height);
  const rawX = (stageX - pageBox.x) / width;
  const rawY = (stageY - pageBox.y) / height;
  if (!clampToPage) {
    return { x: rawX, y: rawY };
  }
  return {
    x: clamp(rawX, 0, 1),
    y: clamp(rawY, 0, 1),
  };
}

function pageNormalizedToStagePoint(normX, normY, pageBox) {
  return {
    x: pageBox.x + normX * pageBox.width,
    y: pageBox.y + normY * pageBox.height,
  };
}

function computeStrokeLineWidth(stroke, targetPageWidth, fallbackScale = 1) {
  const baseSize = Math.max(0.5, Number(stroke?.size) || 1);
  const refWidth = Number(stroke?.refWidth);
  if (Number.isFinite(refWidth) && refWidth > 0 && Number.isFinite(targetPageWidth) && targetPageWidth > 0) {
    return Math.max(0.5, (baseSize / refWidth) * targetPageWidth);
  }
  return Math.max(0.5, baseSize * fallbackScale);
}

function computeSignatureImageBox(signatureBox, pageBox, imageWidth, imageHeight) {
  const safePageWidth = Math.max(1, pageBox.width);
  const safePageHeight = Math.max(1, pageBox.height);
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const pageAspect = safePageWidth / safePageHeight;
  const imageAspect = safeImageWidth / safeImageHeight;
  const padX = signatureBox.width * 0.1;
  const padY = signatureBox.height * 0.22;
  const maxWidth = Math.max(0.01, signatureBox.width - padX * 2);
  const maxHeight = Math.max(0.01, signatureBox.height - padY * 2);
  const containerAspect = (maxWidth * pageAspect) / maxHeight;
  let drawWidth = maxWidth;
  let drawHeight = maxHeight;

  if (imageAspect > containerAspect) {
    drawHeight = (drawWidth * pageAspect) / imageAspect;
  } else {
    drawWidth = (drawHeight * imageAspect) / pageAspect;
  }

  return {
    x: clamp(signatureBox.x + (signatureBox.width - drawWidth) / 2, 0, Math.max(0, 1 - drawWidth)),
    y: clamp(signatureBox.y + (signatureBox.height - drawHeight) / 2, 0, Math.max(0, 1 - drawHeight)),
    width: Math.min(1, drawWidth),
    height: Math.min(1, drawHeight),
  };
}

function computeSignatureBounds(strokes = [], signatureImage = null, padding = 0.03) {
  if (!strokes.length && !signatureImage) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  if (signatureImage) {
    const right = signatureImage.x + signatureImage.width;
    const bottom = signatureImage.y + signatureImage.height;
    if (signatureImage.x < minX) minX = signatureImage.x;
    if (signatureImage.y < minY) minY = signatureImage.y;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }

  if (!Number.isFinite(minX)) return null;
  return {
    minX: Math.max(0, minX - padding),
    minY: Math.max(0, minY - padding),
    maxX: Math.min(1, maxX + padding),
    maxY: Math.min(1, maxY + padding),
  };
}

function computeMoveHandleStagePosition(bounds, pageBox, stageWidth, stageHeight) {
  const safeStageWidth = Math.max(1, stageWidth);
  const safeStageHeight = Math.max(1, stageHeight);
  const anchor = pageNormalizedToStagePoint(bounds.minX, (bounds.minY + bounds.maxY) / 2, pageBox);
  const offsetPx = Math.min(34, Math.max(22, pageBox.width * 0.04));
  const marginX = Math.min(30, safeStageWidth * 0.25);
  const marginY = Math.min(22, safeStageHeight * 0.25);
  const x = clamp(anchor.x - offsetPx, marginX, safeStageWidth - marginX);
  const y = clamp(anchor.y, marginY, safeStageHeight - marginY);
  return {
    x,
    y,
    leftPercent: (x / safeStageWidth) * 100,
    topPercent: (y / safeStageHeight) * 100,
  };
}

function computePdfOverlayPlacement(pageWidth, pageHeight, rotationAngle = 0, originX = 0, originY = 0) {
  const rotation = normalizeRotationDegrees(rotationAngle);
  if (rotation === 90) {
    return {
      x: originX + pageWidth,
      y: originY,
      width: pageHeight,
      height: pageWidth,
      rotateDegrees: 90,
      visualWidth: pageHeight,
      visualHeight: pageWidth,
    };
  }
  if (rotation === 180) {
    return {
      x: originX + pageWidth,
      y: originY + pageHeight,
      width: pageWidth,
      height: pageHeight,
      rotateDegrees: 180,
      visualWidth: pageWidth,
      visualHeight: pageHeight,
    };
  }
  if (rotation === 270) {
    return {
      x: originX,
      y: originY + pageHeight,
      width: pageHeight,
      height: pageWidth,
      rotateDegrees: 270,
      visualWidth: pageHeight,
      visualHeight: pageWidth,
    };
  }
  return {
    x: originX,
    y: originY,
    width: pageWidth,
    height: pageHeight,
    rotateDegrees: 0,
    visualWidth: pageWidth,
    visualHeight: pageHeight,
  };
}

function computeExportOverlayScale(visualWidth, visualHeight, devicePixelRatio = 1, maxDimension = MAX_EXPORT_DIMENSION) {
  const longestEdge = Math.max(1, Number(visualWidth) || 1, Number(visualHeight) || 1);
  const targetScale = Math.max(2, Number(devicePixelRatio) || 1);
  const maxSafeScale = maxDimension / longestEdge;
  return Math.max(0.25, Math.min(targetScale, maxSafeScale));
}

function isPdfFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

function isImageFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function validateUploadFile(file, purpose = "document") {
  if (!file) {
    return { ok: false, error: "未选择文件。" };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "文件内容为空，请重新选择有效文件。" };
  }

  if (purpose === "signature") {
    if (!isImageFile(file)) {
      return { ok: false, error: "签名导入仅支持 PNG、JPG、WebP 等图片格式。" };
    }
    if (size > MAX_IMAGE_BYTES) {
      return { ok: false, error: "签名图片超过 25 MB 限制，请压缩后再导入。" };
    }
    return { ok: true, kind: "image" };
  }

  if (isPdfFile(file)) {
    if (size > MAX_PDF_BYTES) {
      return { ok: false, error: "PDF 文件超过 50 MB 限制，请压缩后再上传。" };
    }
    return { ok: true, kind: "pdf" };
  }

  if (isImageFile(file)) {
    if (size > MAX_IMAGE_BYTES) {
      return { ok: false, error: "图片文件超过 25 MB 限制，请压缩后再上传。" };
    }
    return { ok: true, kind: "image" };
  }

  return { ok: false, error: "不支持的文件格式，请上传 PNG、JPG、WebP 图片或 PDF 文件。" };
}

function strokeLine(points, context) {
  if (!context || !points || points.length === 0) return;

  if (points.length === 1) {
    const dot = points[0];
    context.fillStyle = dot.color;
    context.beginPath();
    context.arc(dot.x, dot.y, Math.max(0.5, dot.size / 2), 0, Math.PI * 2);
    context.fill();
    return;
  }

  context.strokeStyle = points[0].color;
  context.lineWidth = points[0].size;
  context.lineCap = "round";
  context.lineJoin = "round";

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i += 1) {
    const midpoint = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2,
    };
    context.quadraticCurveTo(points[i].x, points[i].y, midpoint.x, midpoint.y);
  }
  const last = points[points.length - 1];
  context.lineTo(last.x, last.y);
  context.stroke();
}

function renderNormalizedSignatureToContext(ctx, targetBox, strokes, signatureImage, options = {}) {
  const { bounds = null, fallbackStrokeScale = 1 } = options;
  const offsetX = bounds ? bounds.minX : 0;
  const offsetY = bounds ? bounds.minY : 0;
  const spanX = bounds ? Math.max(1e-6, bounds.maxX - bounds.minX) : 1;
  const spanY = bounds ? Math.max(1e-6, bounds.maxY - bounds.minY) : 1;
  const fullPageWidth = targetBox.width / spanX;

  if (signatureImage?.image) {
    ctx.drawImage(
      signatureImage.image,
      targetBox.x + ((signatureImage.x - offsetX) / spanX) * targetBox.width,
      targetBox.y + ((signatureImage.y - offsetY) / spanY) * targetBox.height,
      (signatureImage.width / spanX) * targetBox.width,
      (signatureImage.height / spanY) * targetBox.height
    );
  }

  for (const stroke of strokes) {
    const lineWidth = computeStrokeLineWidth(stroke, fullPageWidth, fallbackStrokeScale);
    const denormalized = stroke.points.map((point) => ({
      x: targetBox.x + ((point.x - offsetX) / spanX) * targetBox.width,
      y: targetBox.y + ((point.y - offsetY) / spanY) * targetBox.height,
      color: stroke.color,
      size: lineWidth,
    }));
    strokeLine(denormalized, ctx);
  }
}

async function buildSignedPdfBytes({
  pdfBytes,
  pdfSignatures,
  pdfSignatureImages,
  PDFLibRef,
  devicePixelRatio = 1,
  renderOverlayPngBytes,
}) {
  if (!pdfBytes || !PDFLibRef) {
    throw new Error("PDF 导出组件不可用，请刷新页面后重试。");
  }

  const { PDFDocument, degrees } = PDFLibRef;
  const pdfDoc = await PDFDocument.load(pdfBytes.slice(0));
  const pages = pdfDoc.getPages();

  for (let index = 0; index < pages.length; index += 1) {
    const pageKey = `page-${index + 1}`;
    const strokes = pdfSignatures.get(pageKey) || [];
    const signatureImage = pdfSignatureImages.get(pageKey) || null;
    if (!strokes.length && !signatureImage) continue;

    const page = pages[index];
    const size = page.getSize();
    const cropBox = typeof page.getCropBox === "function" ? page.getCropBox() : null;
    const originX = Number.isFinite(cropBox?.x) ? cropBox.x : 0;
    const originY = Number.isFinite(cropBox?.y) ? cropBox.y : 0;
    const pageWidth = Number.isFinite(cropBox?.width) && cropBox.width > 0 ? cropBox.width : size.width;
    const pageHeight = Number.isFinite(cropBox?.height) && cropBox.height > 0 ? cropBox.height : size.height;
    const rotationAngle = typeof page.getRotation === "function" ? page.getRotation()?.angle : 0;

    const placement = computePdfOverlayPlacement(pageWidth, pageHeight, rotationAngle, originX, originY);
    const exportScale = computeExportOverlayScale(placement.visualWidth, placement.visualHeight, devicePixelRatio);

    const pngArrayBuffer = await renderOverlayPngBytes({
      strokes,
      signatureImage,
      visualWidth: placement.visualWidth,
      visualHeight: placement.visualHeight,
      exportScale,
    });
    if (!pngArrayBuffer) continue;

    const embeddedPng = await pdfDoc.embedPng(pngArrayBuffer);
    page.drawImage(embeddedPng, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: degrees(placement.rotateDegrees),
    });
  }

  return pdfDoc.save();
}

function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片文件失败，请重试。"));
    reader.onabort = () => reject(new Error("图片读取已取消。"));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) {
          reject(new Error("图片尺寸无效，请更换其他图片文件。"));
          return;
        }
        resolve(image);
      };
      image.onerror = () => reject(new Error("图片解析失败，文件可能已损坏或格式不受支持。"));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("生成图片失败，请重试。"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function initSignatureApp() {
  const documentCanvas = document.getElementById("documentCanvas");
  const signatureCanvas = document.getElementById("signatureCanvas");
  const documentInput = document.getElementById("documentInput");
  const documentDropZone = document.getElementById("documentDropZone") || document.querySelector(".file-drop");
  const signatureImportZone = document.getElementById("signatureImportZone");
  const documentName = document.getElementById("documentName");
  const inkColor = document.getElementById("inkColor");
  const inkSize = document.getElementById("inkSize");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const clearBtn = document.getElementById("clearBtn");
  const fitBtn = document.getElementById("fitBtn");
  const downloadSignatureBtn = document.getElementById("downloadSignatureBtn");
  const signatureImportInput = document.getElementById("signatureImportInput");
  const downloadDocumentBtn = document.getElementById("downloadDocumentBtn");
  const signatureMoveHandle = document.getElementById("signatureMoveHandle");
  const strokeStatus = document.getElementById("strokeStatus");
  const appNotice = document.getElementById("appNotice");
  const pageControls = document.getElementById("pageControls");
  const pageIndicator = document.getElementById("pageIndicator");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const documentStage = document.querySelector(".document-stage");

  if (!documentCanvas || !signatureCanvas || !documentStage) return null;

  const docCtx = documentCanvas.getContext("2d");
  const signCtx = signatureCanvas.getContext("2d");

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }

  const state = {
    drawing: false,
    activePointerId: null,
    hasPointerCapture: false,
    lastPoint: null,
    strokes: [],
    redo: [],
    currentStroke: null,
    signatureImage: null,
    documentImage: null,
    mode: "blank",
    documentFileName: "signed-document.png",
    ratio: window.devicePixelRatio || 1,
    stageWidth: 1,
    stageHeight: 1,
    pdfBytes: null,
    pdfDoc: null,
    pdfPage: 1,
    pdfPageCount: 0,
    pdfSignatures: new Map(),
    pdfSignatureImages: new Map(),
    pdfRedos: new Map(),
    renderTask: null,
    renderToken: 0,
    loadToken: 0,
    isExporting: false,
    pageDrawBox: null,
    signatureBox: { ...INITIAL_SIGNATURE_BOX },
    movingSignatureBox: false,
    signatureBoxDrag: null,
    noticeTimer: null,
    resizeTimer: null,
  };

  function showNotice(message) {
    if (!appNotice) return;
    if (state.noticeTimer) {
      clearTimeout(state.noticeTimer);
      state.noticeTimer = null;
    }
    appNotice.textContent = message;
    appNotice.classList.remove("hidden");
    state.noticeTimer = setTimeout(() => {
      appNotice.classList.add("hidden");
      state.noticeTimer = null;
    }, 6000);
  }

  function clearNotice() {
    if (!appNotice) return;
    if (state.noticeTimer) {
      clearTimeout(state.noticeTimer);
      state.noticeTimer = null;
    }
    appNotice.textContent = "";
    appNotice.classList.add("hidden");
  }

  function getActivePageDrawBox() {
    if (state.pageDrawBox && state.pageDrawBox.width > 0 && state.pageDrawBox.height > 0) {
      return state.pageDrawBox;
    }
    const width = Math.max(1, state.stageWidth || documentCanvas.width / state.ratio);
    const height = Math.max(1, state.stageHeight || documentCanvas.height / state.ratio);
    return { x: 0, y: 0, width, height };
  }

  function clientToPagePoint(event, rect = signatureCanvas.getBoundingClientRect()) {
    const source = event.touches ? event.touches[0] : event;
    const pageBox = getActivePageDrawBox();
    const stageX = source.clientX - rect.left;
    const stageY = source.clientY - rect.top;
    const normalized = stagePointToPageNormalized(stageX, stageY, pageBox, { clampToPage: true });
    return {
      x: normalized.x,
      y: normalized.y,
      pressure: source.pressure || 0.5,
    };
  }

  function currentPageKey() {
    return `page-${state.pdfPage}`;
  }

  function saveCurrentPageInk() {
    if (state.mode !== "pdf") return;
    state.pdfSignatures.set(currentPageKey(), cloneInk(state.strokes));
    state.pdfSignatureImages.set(currentPageKey(), cloneSignatureImage(state.signatureImage));
    state.pdfRedos.set(currentPageKey(), cloneInk(state.redo));
  }

  function loadCurrentPageInk() {
    if (state.mode !== "pdf") return;
    state.strokes = cloneInk(state.pdfSignatures.get(currentPageKey()) || []);
    state.signatureImage = cloneSignatureImage(state.pdfSignatureImages.get(currentPageKey()));
    state.redo = cloneInk(state.pdfRedos.get(currentPageKey()) || []);
  }

  function setStageAspect(width, height) {
    if (width > 0 && height > 0) {
      documentStage.style.setProperty("--stage-aspect", `${width} / ${height}`);
    }
  }

  function syncCanvasDimensions() {
    const rect = documentStage.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = window.devicePixelRatio || 1;
    state.ratio = ratio;
    state.stageWidth = width;
    state.stageHeight = height;

    for (const canvas of [documentCanvas, signatureCanvas]) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    for (const ctx of [docCtx, signCtx]) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    return { width, height };
  }

  function resizeCanvases() {
    syncCanvasDimensions();
    drawDocument();
    redrawSignature();
  }

  function clearSignatureCanvas() {
    signCtx.clearRect(0, 0, state.stageWidth, state.stageHeight);
    signatureMoveHandle.classList.add("hidden");
  }

  function drawBlankDocument(width, height) {
    state.pageDrawBox = { x: 0, y: 0, width, height };
  }

  async function renderPdfPage() {
    if (!state.pdfDoc) return;
    const token = ++state.renderToken;
    const activeDoc = state.pdfDoc;
    const targetPage = state.pdfPage;

    if (state.renderTask) {
      try {
        state.renderTask.cancel();
      } catch {
        // Ignore cancel errors from already-finished tasks.
      }
      state.renderTask = null;
    }

    let page;
    try {
      page = await activeDoc.getPage(targetPage);
    } catch (error) {
      if (token === state.renderToken) {
        console.error(error);
        showNotice("PDF 页面渲染失败，请重试。");
      }
      return;
    }

    if (token !== state.renderToken || state.pdfDoc !== activeDoc) return;

    const baseViewport = page.getViewport({ scale: 1 });
    setStageAspect(baseViewport.width, baseViewport.height);
    const { width, height } = syncCanvasDimensions();
    const pageBox = computePageDrawBox(width, height, baseViewport.width, baseViewport.height);
    state.pageDrawBox = pageBox;

    // Realign ink immediately with the new page aspect ratio before async rasterization finishes.
    redrawSignature();

    const scale = Math.min(width / baseViewport.width, height / baseViewport.height);
    const viewport = page.getViewport({ scale: scale * state.ratio });

    const renderCanvas = document.createElement("canvas");
    renderCanvas.width = Math.max(1, Math.ceil(viewport.width));
    renderCanvas.height = Math.max(1, Math.ceil(viewport.height));
    const renderCtx = renderCanvas.getContext("2d");

    const renderTask = page.render({ canvasContext: renderCtx, viewport });
    state.renderTask = renderTask;

    try {
      await renderTask.promise;
      if (token !== state.renderToken || state.pdfDoc !== activeDoc) return;
      docCtx.setTransform(state.ratio, 0, 0, state.ratio, 0, 0);
      docCtx.clearRect(0, 0, width, height);
      docCtx.drawImage(renderCanvas, pageBox.x, pageBox.y, pageBox.width, pageBox.height);
      redrawSignature();
    } catch (error) {
      if (error?.name !== "RenderingCancelledException" && token === state.renderToken) {
        console.error(error);
        showNotice("PDF 页面渲染中断，请尝试重新翻页。");
      }
    } finally {
      if (state.renderTask === renderTask) {
        state.renderTask = null;
      }
      renderCanvas.width = 0;
      renderCanvas.height = 0;
    }
  }

  function drawDocument() {
    const width = state.stageWidth;
    const height = state.stageHeight;
    docCtx.clearRect(0, 0, width, height);

    if (state.mode === "pdf") {
      renderPdfPage();
      return;
    }

    if (!state.documentImage) {
      drawBlankDocument(width, height);
      return;
    }

    const image = state.documentImage;
    const imgWidth = image.naturalWidth || image.width;
    const imgHeight = image.naturalHeight || image.height;
    const pageBox = computePageDrawBox(width, height, imgWidth, imgHeight);
    state.pageDrawBox = pageBox;
    docCtx.drawImage(image, pageBox.x, pageBox.y, pageBox.width, pageBox.height);
  }

  function redrawSignature(options = {}) {
    const { updateUi = true } = options;
    const pageBox = getActivePageDrawBox();
    signCtx.clearRect(0, 0, state.stageWidth, state.stageHeight);
    renderNormalizedSignatureToContext(signCtx, pageBox, state.strokes, state.signatureImage);

    if (updateUi) {
      updateButtons();
    } else {
      positionSignatureMoveHandle();
    }
  }

  function anyPdfPageHasInk() {
    if (state.mode !== "pdf") return false;
    if (state.strokes.length > 0 || Boolean(state.signatureImage)) return true;
    const currentKey = currentPageKey();
    for (const [key, strokes] of state.pdfSignatures.entries()) {
      if (key !== currentKey && strokes.length > 0) return true;
    }
    for (const [key, image] of state.pdfSignatureImages.entries()) {
      if (key !== currentKey && Boolean(image)) return true;
    }
    return false;
  }

  function positionSignatureMoveHandle(hasInk = state.strokes.length > 0 || Boolean(state.signatureImage)) {
    const bounds = computeSignatureBounds(state.strokes, state.signatureImage, 0.01);
    if (!hasInk || !bounds) {
      signatureMoveHandle.classList.add("hidden");
      return;
    }

    const pageBox = getActivePageDrawBox();
    const handlePos = computeMoveHandleStagePosition(bounds, pageBox, state.stageWidth, state.stageHeight);
    signatureMoveHandle.style.left = `${handlePos.leftPercent}%`;
    signatureMoveHandle.style.top = `${handlePos.topPercent}%`;
    signatureMoveHandle.classList.remove("hidden");
  }

  function updateButtons() {
    const hasInk = state.strokes.length > 0 || Boolean(state.signatureImage);
    const hasActiveInk = Boolean(state.currentStroke && state.currentStroke.points.length >= 1);
    const hasVisibleInk = hasInk || hasActiveInk;
    const hasAnyInk = state.mode === "pdf" ? anyPdfPageHasInk() : hasInk;

    undoBtn.disabled = !hasInk || state.isExporting;
    redoBtn.disabled = state.redo.length === 0 || state.isExporting;
    clearBtn.disabled = !hasInk || state.isExporting;
    downloadSignatureBtn.disabled = !hasInk || state.isExporting;

    strokeStatus.textContent = hasVisibleInk ? "已签字" : "未签字";
    strokeStatus.classList.toggle("signed", hasVisibleInk);

    if (state.isExporting) {
      downloadDocumentBtn.textContent = "正在导出...";
      downloadDocumentBtn.disabled = true;
      downloadDocumentBtn.setAttribute("aria-busy", "true");
    } else {
      downloadDocumentBtn.textContent = state.mode === "pdf" ? "导出 PDF" : "导出签署稿";
      downloadDocumentBtn.disabled = state.mode === "pdf" && !window.PDFLib;
      downloadDocumentBtn.removeAttribute("aria-busy");
    }

    pageControls.classList.toggle("hidden", state.mode !== "pdf");
    pageIndicator.textContent = `${state.pdfPage} / ${Math.max(state.pdfPageCount, 1)}`;
    prevPageBtn.disabled = state.mode !== "pdf" || state.pdfPage <= 1 || state.isExporting;
    nextPageBtn.disabled = state.mode !== "pdf" || state.pdfPage >= state.pdfPageCount || state.isExporting;

    if (state.mode === "pdf" && hasAnyInk && !hasInk && !hasActiveInk) {
      strokeStatus.textContent = "本页未签";
    }
    positionSignatureMoveHandle(hasInk);
  }

  function placeSignatureImage(image) {
    const pageBox = getActivePageDrawBox();
    const imgWidth = image.naturalWidth || image.width;
    const imgHeight = image.naturalHeight || image.height;
    const placed = computeSignatureImageBox(state.signatureBox, pageBox, imgWidth, imgHeight);

    state.strokes = [];
    state.redo = [];
    state.signatureImage = {
      image,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    };
    saveCurrentPageInk();
    redrawSignature();
  }

  async function importSignatureImage(file) {
    if (!file) return;
    const validation = validateUploadFile(file, "signature");
    if (!validation.ok) {
      showNotice(validation.error);
      return;
    }

    clearNotice();
    try {
      const image = await decodeImageFile(file);
      placeSignatureImage(image);
    } catch (error) {
      console.error(error);
      showNotice(error?.message || "签名图片读取失败，请确认文件未损坏。");
    }
  }

  function beginStroke(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (state.drawing || state.movingSignatureBox || state.isExporting) return;

    event.preventDefault();
    const rect = signatureCanvas.getBoundingClientRect();
    const pageBox = getActivePageDrawBox();
    const point = clientToPagePoint(event, rect);

    state.activePointerId = event.pointerId;
    state.hasPointerCapture = false;
    try {
      signatureCanvas.setPointerCapture(event.pointerId);
      state.hasPointerCapture = true;
    } catch {
      state.hasPointerCapture = false;
    }

    state.drawing = true;
    state.redo = [];
    state.currentStroke = {
      color: inkColor.value,
      size: Number(inkSize.value),
      refWidth: pageBox.width,
      points: [point],
    };
    state.lastPoint = point;

    const stageDot = pageNormalizedToStagePoint(point.x, point.y, pageBox);
    strokeLine(
      [
        {
          x: stageDot.x,
          y: stageDot.y,
          color: state.currentStroke.color,
          size: state.currentStroke.size,
        },
      ],
      signCtx
    );

    updateButtons();
  }

  function moveStroke(event) {
    if (!state.drawing || !state.currentStroke || event.pointerId !== state.activePointerId) {
      return;
    }
    event.preventDefault();

    const rect = signatureCanvas.getBoundingClientRect();
    const pageBox = getActivePageDrawBox();
    const point = stabilizePoint(state.lastPoint, clientToPagePoint(event, rect), 0.42);
    const minStep = 0.75 / Math.max(pageBox.width, pageBox.height, 1);
    if (distanceBetween(state.lastPoint, point) < minStep) return;

    const fromStage = pageNormalizedToStagePoint(state.lastPoint.x, state.lastPoint.y, pageBox);
    const toStage = pageNormalizedToStagePoint(point.x, point.y, pageBox);
    strokeLine(
      [
        {
          x: fromStage.x,
          y: fromStage.y,
          color: state.currentStroke.color,
          size: state.currentStroke.size,
        },
        {
          x: toStage.x,
          y: toStage.y,
          color: state.currentStroke.color,
          size: state.currentStroke.size,
        },
      ],
      signCtx
    );

    state.currentStroke.points.push(point);
    state.lastPoint = point;
  }

  function endStroke(event) {
    if (!state.drawing || !state.currentStroke) {
      if (!state.movingSignatureBox) signatureCanvas.style.cursor = "crosshair";
      return;
    }
    if (event.pointerId !== state.activePointerId) return;
    if (event.type === "pointerleave" && state.hasPointerCapture) return;

    event.preventDefault?.();
    if (state.hasPointerCapture && signatureCanvas.hasPointerCapture?.(event.pointerId)) {
      try {
        signatureCanvas.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release errors when capture is already lost.
      }
    }

    state.drawing = false;
    state.activePointerId = null;
    state.hasPointerCapture = false;

    if (state.currentStroke.points.length >= 1) {
      state.strokes.push(state.currentStroke);
      saveCurrentPageInk();
    }

    state.currentStroke = null;
    state.lastPoint = null;
    redrawSignature();
  }

  function beginMoveSignatureBox(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (state.drawing || state.movingSignatureBox || state.isExporting) return;

    event.preventDefault();
    event.stopPropagation();

    const pageBox = getActivePageDrawBox();
    const startBounds = computeSignatureBounds(state.strokes, state.signatureImage, 0);
    if (!startBounds) return;

    state.movingSignatureBox = true;
    state.signatureBoxDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pageBox: { ...pageBox },
      boxX: state.signatureBox.x,
      boxY: state.signatureBox.y,
      startStrokes: cloneInk(state.strokes),
      startImage: cloneSignatureImage(state.signatureImage),
      startRedo: cloneInk(state.redo),
      startBounds,
    };

    try {
      signatureMoveHandle.setPointerCapture(event.pointerId);
    } catch {
      // Fallback to window listeners if pointer capture is unavailable.
    }
  }

  function moveSignatureBox(event) {
    if (!state.movingSignatureBox || !state.signatureBoxDrag) return;
    if (event.pointerId !== state.signatureBoxDrag.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const drag = state.signatureBoxDrag;
    const rawDx = (event.clientX - drag.startX) / Math.max(1, drag.pageBox.width);
    const rawDy = (event.clientY - drag.startY) / Math.max(1, drag.pageBox.height);
    const dx = clamp(rawDx, -drag.startBounds.minX, 1 - drag.startBounds.maxX);
    const dy = clamp(rawDy, -drag.startBounds.minY, 1 - drag.startBounds.maxY);

    state.strokes = drag.startStrokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x + dx,
        y: point.y + dy,
      })),
    }));
    state.redo = drag.startRedo.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x + dx,
        y: point.y + dy,
      })),
    }));

    if (drag.startImage) {
      state.signatureImage = {
        ...drag.startImage,
        x: drag.startImage.x + dx,
        y: drag.startImage.y + dy,
      };
    }

    state.signatureBox.x = clamp(drag.boxX + dx, 0, Math.max(0, 1 - state.signatureBox.width));
    state.signatureBox.y = clamp(drag.boxY + dy, 0, Math.max(0, 1 - state.signatureBox.height));
    redrawSignature({ updateUi: false });
  }

  function endMoveSignatureBox(event) {
    if (!state.movingSignatureBox || !state.signatureBoxDrag) return;
    if (event.pointerId !== state.signatureBoxDrag.pointerId) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    const pointerId = state.signatureBoxDrag.pointerId;
    state.movingSignatureBox = false;
    state.signatureBoxDrag = null;
    saveCurrentPageInk();

    if (signatureMoveHandle.hasPointerCapture?.(pointerId)) {
      try {
        signatureMoveHandle.releasePointerCapture(pointerId);
      } catch {
        // Ignore release errors.
      }
    }
    updateButtons();
  }

  function clearSignature() {
    if (state.isExporting) return;
    state.strokes = [];
    state.signatureImage = null;
    state.redo = [];
    saveCurrentPageInk();
    redrawSignature();
  }

  function undo() {
    if (state.isExporting) return;
    if (state.signatureImage && state.strokes.length === 0) {
      state.signatureImage = null;
      saveCurrentPageInk();
      redrawSignature();
      return;
    }
    const stroke = state.strokes.pop();
    if (stroke) {
      state.redo.push(stroke);
      saveCurrentPageInk();
      redrawSignature();
    }
  }

  function redo() {
    if (state.isExporting) return;
    const stroke = state.redo.pop();
    if (stroke) {
      state.strokes.push(stroke);
      saveCurrentPageInk();
      redrawSignature();
    }
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 3000);
  }

  async function exportSignature() {
    const bounds = computeSignatureBounds(state.strokes, state.signatureImage, 0.03);
    if (!bounds) return;

    try {
      clearNotice();
      const pageBox = getActivePageDrawBox();
      const exportDpr = computeExportOverlayScale(
        (bounds.maxX - bounds.minX) * pageBox.width,
        (bounds.maxY - bounds.minY) * pageBox.height,
        state.ratio
      );
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.round((bounds.maxX - bounds.minX) * pageBox.width * exportDpr));
      crop.height = Math.max(1, Math.round((bounds.maxY - bounds.minY) * pageBox.height * exportDpr));
      const cropCtx = crop.getContext("2d");
      renderNormalizedSignatureToContext(
        cropCtx,
        { x: 0, y: 0, width: crop.width, height: crop.height },
        state.strokes,
        state.signatureImage,
        { bounds, fallbackStrokeScale: exportDpr }
      );
      const blob = await canvasToPngBlob(crop);
      downloadBlob(blob, "signature.png");
    } catch (error) {
      console.error(error);
      showNotice(error?.message || "导出签名失败，请重试。");
    }
  }

  async function exportImageDocument() {
    const pageBox = getActivePageDrawBox();
    const output = document.createElement("canvas");
    if (state.mode === "image" && state.documentImage) {
      output.width = state.documentImage.naturalWidth || state.documentImage.width;
      output.height = state.documentImage.naturalHeight || state.documentImage.height;
    } else {
      const exportScale = computeExportOverlayScale(pageBox.width, pageBox.height, state.ratio);
      output.width = Math.max(1, Math.round(pageBox.width * exportScale));
      output.height = Math.max(1, Math.round(pageBox.height * exportScale));
    }

    const ctx = output.getContext("2d");
    if (state.mode === "image" && state.documentImage) {
      ctx.drawImage(state.documentImage, 0, 0, output.width, output.height);
    } else {
      ctx.fillStyle = "#fffdf8";
      ctx.fillRect(0, 0, output.width, output.height);
    }

    const fallbackScale = output.width / Math.max(1, pageBox.width);
    ctx.save();
    ctx.rect(0, 0, output.width, output.height);
    ctx.clip();
    renderNormalizedSignatureToContext(
      ctx,
      { x: 0, y: 0, width: output.width, height: output.height },
      state.strokes,
      state.signatureImage,
      { fallbackStrokeScale: fallbackScale }
    );
    ctx.restore();

    const blob = await canvasToPngBlob(output);
    downloadBlob(blob, state.documentFileName);
  }

  async function exportPdfDocument() {
    if (!state.pdfBytes || !window.PDFLib) {
      throw new Error("PDF 导出组件未就绪，请检查网络后刷新页面。");
    }
    saveCurrentPageInk();

    const pdfBytes = await buildSignedPdfBytes({
      pdfBytes: state.pdfBytes,
      pdfSignatures: state.pdfSignatures,
      pdfSignatureImages: state.pdfSignatureImages,
      PDFLibRef: window.PDFLib,
      devicePixelRatio: state.ratio,
      renderOverlayPngBytes: async ({ strokes, signatureImage, visualWidth, visualHeight, exportScale }) => {
        const overlay = document.createElement("canvas");
        overlay.width = Math.max(1, Math.round(visualWidth * exportScale));
        overlay.height = Math.max(1, Math.round(visualHeight * exportScale));
        const overlayCtx = overlay.getContext("2d");
        overlayCtx.setTransform(exportScale, 0, 0, exportScale, 0, 0);

        renderNormalizedSignatureToContext(
          overlayCtx,
          { x: 0, y: 0, width: visualWidth, height: visualHeight },
          strokes,
          signatureImage,
          { fallbackStrokeScale: 1 }
        );

        try {
          const blob = await canvasToPngBlob(overlay);
          return await blob.arrayBuffer();
        } finally {
          overlay.width = 0;
          overlay.height = 0;
        }
      },
    });

    downloadBlob(new Blob([pdfBytes], { type: "application/pdf" }), state.documentFileName);
  }

  async function exportDocument() {
    if (state.isExporting) return;
    clearNotice();
    state.isExporting = true;
    updateButtons();

    try {
      if (state.mode === "pdf") {
        await exportPdfDocument();
      } else {
        await exportImageDocument();
      }
    } catch (error) {
      console.error(error);
      showNotice(error?.message || "导出失败，请重试。");
    } finally {
      state.isExporting = false;
      updateButtons();
    }
  }

  function resetDocumentState(mode) {
    state.renderToken += 1;
    if (state.renderTask) {
      try {
        state.renderTask.cancel();
      } catch {
        // Ignore cancel errors.
      }
      state.renderTask = null;
    }
    if (typeof state.pdfDoc?.destroy === "function") {
      Promise.resolve(state.pdfDoc.destroy()).catch(() => {});
    }
    state.mode = mode;
    state.drawing = false;
    state.activePointerId = null;
    state.hasPointerCapture = false;
    state.movingSignatureBox = false;
    state.signatureBoxDrag = null;
    state.strokes = [];
    state.redo = [];
    state.currentStroke = null;
    state.lastPoint = null;
    state.signatureImage = null;
    state.documentImage = null;
    state.pdfBytes = null;
    state.pdfDoc = null;
    state.pdfPage = 1;
    state.pdfPageCount = 0;
    state.pdfSignatures = new Map();
    state.pdfSignatureImages = new Map();
    state.pdfRedos = new Map();
    state.pageDrawBox = null;
    state.signatureBox = { ...INITIAL_SIGNATURE_BOX };
  }

  function resetWorkspace() {
    if (state.isExporting) return;
    state.loadToken += 1;
    clearNotice();
    resetDocumentState("blank");
    documentName.textContent = "空白签署页";
    state.documentFileName = "signed-document.png";
    inkColor.value = "#101820";
    inkSize.value = "4";
    documentInput.value = "";
    signatureImportInput.value = "";
    documentStage.style.removeProperty("--stage-aspect");
    syncSwatches();
    resizeCanvases();
    updateButtons();
  }

  async function loadImageDocument(file) {
    const validation = validateUploadFile(file, "document");
    if (!validation.ok || validation.kind !== "image") {
      showNotice(validation.error || "不支持的图片文件。");
      return;
    }

    const loadToken = ++state.loadToken;
    clearNotice();

    try {
      const image = await decodeImageFile(file);
      if (loadToken !== state.loadToken) return;

      resetDocumentState("image");
      state.documentImage = image;
      state.documentFileName = `${file.name.replace(/\.[^.]+$/, "")}-signed.png`;
      documentName.textContent = file.name;
      setStageAspect(image.naturalWidth || image.width, image.naturalHeight || image.height);
      resizeCanvases();
    } catch (error) {
      console.error(error);
      if (loadToken === state.loadToken) {
        showNotice(error?.message || "图片读取失败，当前文档已保留。");
      }
    }
  }

  async function loadPdfDocument(file) {
    const validation = validateUploadFile(file, "document");
    if (!validation.ok || validation.kind !== "pdf") {
      showNotice(validation.error || "无效的 PDF 文件。");
      return;
    }

    if (!window.pdfjsLib || !window.PDFLib) {
      showNotice("PDF 组件加载失败，请检查网络后刷新页面。");
      return;
    }

    const loadToken = ++state.loadToken;
    clearNotice();
    let nextPdfDoc = null;

    try {
      const bytes = await file.arrayBuffer();
      if (loadToken !== state.loadToken) return;

      nextPdfDoc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
      if (!nextPdfDoc || nextPdfDoc.numPages < 1) {
        throw new Error("该 PDF 文件不包含有效页面。");
      }

      const firstPage = await nextPdfDoc.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });

      if (loadToken !== state.loadToken) {
        if (typeof nextPdfDoc.destroy === "function") {
          Promise.resolve(nextPdfDoc.destroy()).catch(() => {});
        }
        return;
      }

      resetDocumentState("pdf");
      state.pdfBytes = bytes;
      state.pdfDoc = nextPdfDoc;
      nextPdfDoc = null;
      state.pdfPage = 1;
      state.pdfPageCount = state.pdfDoc.numPages;
      state.documentFileName = `${file.name.replace(/\.[^.]+$/, "")}-signed.pdf`;
      documentName.textContent = file.name;

      setStageAspect(viewport.width, viewport.height);
      resizeCanvases();
    } catch (error) {
      console.error(error);
      if (nextPdfDoc && typeof nextPdfDoc.destroy === "function") {
        Promise.resolve(nextPdfDoc.destroy()).catch(() => {});
      }
      if (loadToken === state.loadToken) {
        const message =
          error?.name === "PasswordException"
            ? "暂不支持加密或需要密码的 PDF 文件，当前文档已保留。"
            : error?.message && error.message.includes("PDF")
              ? error.message
              : "PDF 解析失败，请确认文件未损坏，当前文档已保留。";
        showNotice(message);
      }
    }
  }

  function loadDocument(file) {
    if (!file) return;
    const validation = validateUploadFile(file, "document");
    if (!validation.ok) {
      showNotice(validation.error);
      return;
    }
    if (validation.kind === "pdf") {
      loadPdfDocument(file);
      return;
    }
    loadImageDocument(file);
  }

  async function goToPdfPage(nextPage) {
    if (state.mode !== "pdf" || state.isExporting) return;
    if (nextPage < 1 || nextPage > state.pdfPageCount || nextPage === state.pdfPage) return;

    saveCurrentPageInk();
    state.pdfPage = nextPage;
    loadCurrentPageInk();
    clearSignatureCanvas();
    updateButtons();
    await renderPdfPage();
  }

  function syncSwatches() {
    document.querySelectorAll(".swatch").forEach((button) => {
      const isActive = button.dataset.color === inkColor.value;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function wireFileDropZone(element, onFile) {
    if (!element) return;
    let dragDepth = 0;

    element.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragDepth += 1;
      element.classList.add("is-dragover");
    });

    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      element.classList.add("is-dragover");
    });

    element.addEventListener("dragleave", (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        element.classList.remove("is-dragover");
      }
    });

    element.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      element.classList.remove("is-dragover");
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    });
  }

  function handleKeydown(event) {
    if (state.drawing || state.movingSignatureBox || state.isExporting) return;
    const target = event.target;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === "TEXTAREA" ||
        (target.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "color", "file"].includes(target.type)))
    ) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    }
  }

  documentInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) loadDocument(file);
  });

  signatureImportInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) importSignatureImage(file);
  });

  wireFileDropZone(documentDropZone, loadDocument);
  wireFileDropZone(signatureImportZone, importSignatureImage);

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  clearBtn.addEventListener("click", clearSignature);
  fitBtn.addEventListener("click", resetWorkspace);
  downloadSignatureBtn.addEventListener("click", exportSignature);
  downloadDocumentBtn.addEventListener("click", exportDocument);
  prevPageBtn.addEventListener("click", () => goToPdfPage(state.pdfPage - 1));
  nextPageBtn.addEventListener("click", () => goToPdfPage(state.pdfPage + 1));
  inkColor.addEventListener("input", syncSwatches);

  document.querySelectorAll(".swatch").forEach((button) => {
    button.addEventListener("click", () => {
      inkColor.value = button.dataset.color;
      syncSwatches();
    });
  });

  signatureCanvas.addEventListener("pointerdown", beginStroke);
  signatureCanvas.addEventListener("pointermove", moveStroke);
  signatureCanvas.addEventListener("pointerup", endStroke);
  signatureCanvas.addEventListener("pointerleave", endStroke);
  signatureCanvas.addEventListener("pointercancel", endStroke);
  signatureCanvas.addEventListener("lostpointercapture", endStroke);

  signatureMoveHandle.addEventListener("pointerdown", beginMoveSignatureBox);
  window.addEventListener("pointermove", moveSignatureBox);
  window.addEventListener("pointerup", endMoveSignatureBox);
  window.addEventListener("pointercancel", endMoveSignatureBox);
  window.addEventListener("keydown", handleKeydown);

  window.addEventListener("resize", () => {
    if (state.resizeTimer) {
      clearTimeout(state.resizeTimer);
    }
    state.resizeTimer = setTimeout(() => {
      state.resizeTimer = null;
      saveCurrentPageInk();
      resizeCanvases();
    }, RESIZE_DEBOUNCE_MS);
  });

  resizeCanvases();
  updateButtons();
  return { state, goToPdfPage, loadPdfDocument, loadImageDocument, importSignatureImage, exportDocument };
}

if (typeof document !== "undefined") {
  initSignatureApp();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_PDF_BYTES,
    MAX_IMAGE_BYTES,
    MAX_EXPORT_DIMENSION,
    INITIAL_SIGNATURE_BOX,
    clamp,
    distanceBetween,
    stabilizePoint,
    cloneInk,
    cloneSignatureImage,
    normalizeRotationDegrees,
    computePageDrawBox,
    stagePointToPageNormalized,
    pageNormalizedToStagePoint,
    computeStrokeLineWidth,
    computeSignatureImageBox,
    computeSignatureBounds,
    computeMoveHandleStagePosition,
    computePdfOverlayPlacement,
    computeExportOverlayScale,
    isPdfFile,
    isImageFile,
    validateUploadFile,
    strokeLine,
    renderNormalizedSignatureToContext,
    buildSignedPdfBytes,
    initSignatureApp,
  };
}
