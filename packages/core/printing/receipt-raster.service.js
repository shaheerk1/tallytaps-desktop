"use strict";

const fs = require("fs");
const path = require("path");
const {
  localizeReceiptDocument,
  localizeReceiptLabel,
  normalizeReceiptLanguage,
} = require("./receipt-localization.service");

const RECEIPT_WIDTH = 576;
// Keep Chromium's vertical scrollbar outside the 576-dot printable canvas.
// Without this gutter Windows reduces the content width, then captures the
// scrollbar and clips the right/bottom edges of longer receipts.
const RENDER_VIEWPORT_WIDTH = RECEIPT_WIDTH + 32;
// Keep individual GS v 0 raster commands comfortably below the USB/printer
// buffer limits found in common 80 mm thermal printers. These are cropped
// from one continuous receipt image, never independently screen-captured.
const PRINTER_STRIP_HEIGHT = 480;
const INITIAL_RENDER_HEIGHT = 720;
const fontDirectory = path.join(__dirname, "assets", "fonts");
const fontCss = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fontFace(name, file) {
  const data = fs
    .readFileSync(path.join(fontDirectory, file))
    .toString("base64");
  return `@font-face{font-family:${name};src:url(data:font/ttf;base64,${data}) format('truetype');font-display:block;}`;
}

function receiptFontCss(language) {
  const file =
    language === "si-LK" ? "NotoSansSinhala.ttf" : "NotoSansTamil.ttf";
  const family = language === "si-LK" ? "DdecSinhala" : "DdecTamil";
  if (!fontCss.has(language)) fontCss.set(language, fontFace(family, file));
  return { css: fontCss.get(language), family };
}

function lineHtml(text, className = "") {
  return `<div class="${className}">${escapeHtml(text)}</div>`;
}

function receiptHtml(input) {
  const doc = localizeReceiptDocument(input);
  const language = normalizeReceiptLanguage(doc.receiptLanguage);
  const font = receiptFontCss(language);
  const t = (value) => localizeReceiptLabel(value, language);
  const brand = doc.brand || {};
  // The standard ESC/POS path prints this from doc.logoDataUrl. Keep the same
  // source in the Unicode raster path, while accepting only an inline image.
  const logoDataUrl = /^data:image\/[a-z0-9.+-]+;base64,/i.test(
    String(doc.logoDataUrl || ""),
  )
    ? String(doc.logoDataUrl)
    : "";
  const meta = (doc.meta || [])
    .map(
      (row) =>
        `<div class="meta"><span>${escapeHtml(row.label)}</span><span>${escapeHtml(row.value)}</span></div>`,
    )
    .join("");
  const secondary = (doc.secondaryHeaderLines || [])
    .filter((row) => String(row?.text || "").trim())
    .map((row) => {
      const emphasis = `${row.bold ? "bold" : ""} ${row.size ? "large" : ""}`;
      if (row.identity) {
        return `<div class="identity ${emphasis}"><span>${escapeHtml(row.identity.left || "")}</span><span>${escapeHtml(row.identity.right || "")}</span></div>`;
      }
      return lineHtml(row.text, `${row.align || "center"} ${emphasis}`);
    })
    .join("");
  const standardItems = (doc.items || [])
    .map(
      (item) =>
        `<section class="standard-item"><div class="bold">${escapeHtml(item.description)}</div><div class="split"><span>${escapeHtml(item.qty || "")}</span><strong>${escapeHtml(item.amount || "")}</strong></div>${(item.extras || []).map((extra) => lineHtml(`${extra.label}: ${extra.value}`, "small")).join("")}</section>`,
    )
    .join("");
  const measureItems = (doc.items || [])
    .map((item) => {
      const measure = item.measure || {};
      return `<section class="measure-item"><div class="description">${escapeHtml(item.description)}</div><div class="measure-row"><span>${escapeHtml(measure.qty || "")}</span><span>${measure.kilos ? "/" : ""}</span><span>${escapeHtml(measure.kilos || "")}</span><span>x</span><span>${escapeHtml(measure.rate || "")}</span><strong>${escapeHtml(item.amount || "")}</strong></div>${(item.extras || []).map((extra) => lineHtml(`${extra.label}: ${extra.value}`, "small")).join("")}</section>`;
    })
    .join("");
  const itemLayout =
    doc.itemLayout === "invoice-measures"
      ? `<section class="items"><div class="item-title bold">${escapeHtml(t("ITEM"))}</div><div class="measure-head bold"><span>${escapeHtml(t("QTY"))}</span><span></span><span>${escapeHtml(t("KG"))}</span><span></span><span>${escapeHtml(t("RATE"))}</span><span>${escapeHtml(t("AMOUNT"))}</span></div>${measureItems}</section>`
      : `<section class="items standard">${standardItems}</section>`;
  const totals = (doc.totals || [])
    .map((row, index) => {
      const label =
        index === 0 &&
        doc.quantityTotal !== undefined &&
        doc.quantityTotal !== null
          ? `${t("QTY TOTAL")}: ${doc.quantityTotal}`
          : row.label;
      return `<div class="total ${row.bold ? "grand bold" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(row.value)}</strong></div>`;
    })
    .join("");
  const footer = (doc.footerLines || [])
    .filter(Boolean)
    .map((line) => lineHtml(line, "center"))
    .join("");
  const address = (brand.addressLines || [])
    .map((line) => lineHtml(line, "center"))
    .join("");
  const billingMasthead = doc.rasterHeaderLayout === "billing";
  const brandHeader = billingMasthead
    ? `<div class="masthead ${logoDataUrl ? "" : "masthead--no-logo"}">
         ${logoDataUrl ? `<div class="masthead-logo"><img class="logo" src="${logoDataUrl}" alt="" /></div>` : ""}
         <div class="masthead-info">
           ${brand.name ? lineHtml(t(brand.name), "store bold") : ""}
           ${brand.tagline ? lineHtml(brand.tagline) : ""}
           ${(brand.addressLines || []).map((line) => lineHtml(line)).join("")}
           ${brand.phone ? lineHtml(`${t("TEL")}: ${brand.phone}`) : ""}
         </div>
       </div>`
    : `${logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="" />` : ""}${brand.name ? lineHtml(t(brand.name), "store bold") : ""}${brand.tagline ? lineHtml(brand.tagline) : ""}${address}${brand.phone ? lineHtml(`${t("TEL")}: ${brand.phone}`) : ""}`;
  // return `<!doctype html><html><head><meta charset="utf-8"><style>${font.css}*{box-sizing:border-box}html,body{margin:0;padding:0;width:${RECEIPT_WIDTH}px;background:#fff;color:#000;overflow-x:hidden}body{font-family:${font.family},Arial,sans-serif;font-size:24px;line-height:1.28;padding:12px 14px 24px 5px}.center{text-align:center}.left{text-align:left}.right{text-align:right}.bold,strong{font-weight:600}.large{font-size:29px}.brand{padding-bottom:8px}.identity{display:flex;justify-content:space-between;gap:14px;text-align:left;white-space:nowrap}.identity span:last-child{text-align:right}.logo{display:block;max-width:160px;max-height:88px;margin:0 auto 7px;object-fit:contain}.store{font-size:30px}.rule{border-top:2px solid #000;margin:8px 0}.dash{border-top-style:dashed}.meta,.total,.split{display:flex;justify-content:space-between;gap:10px}.meta span:first-child{font-weight:600}.items{border:2px solid #000}.item-title{padding:4px 7px;border-bottom:2px solid #000}.measure-head,.measure-row{display:grid;grid-template-columns:72px 16px 82px 18px 110px 1fr;gap:0;padding:4px 7px}.measure-head{border-bottom:2px solid #000;font-size:19px}.measure-item{border-bottom:1px solid #000}.measure-item:last-child{border-bottom:0}.description{padding:5px 7px 0;font-weight:600}.measure-row{padding-top:2px;padding-bottom:5px}.measure-row strong{text-align:right}.small{padding:0 7px 5px;font-size:19px}.total{padding:4px 2px}.grand{border-top:2px solid #000;margin-top:4px;padding-top:6px;font-size:26px}.standard-item{padding:5px 2px;border-bottom:1px solid #000}.standard-item:last-child{border-bottom:0}</style></head><body><header class="brand center">${logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="" />` : ""}${brand.name ? lineHtml(t(brand.name), "store bold") : ""}${brand.tagline ? lineHtml(brand.tagline) : ""}${address}${brand.phone ? lineHtml(`${t("TEL")}: ${brand.phone}`) : ""}${secondary}</header><div class="rule"></div>${meta ? `<section>${meta}</section><div class="rule dash"></div>` : ""}${itemLayout}<div class="rule dash"></div><section>${totals}</section>${footer ? `<div class="rule dash"></div><footer>${footer}</footer>` : ""}</body></html>`;
    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            ${font.css}
            * { box-sizing: border-box; }
            html, body {
              margin: 0;
              padding: 0;
              width: ${RECEIPT_WIDTH}px;
              background: #fff;
              color: #000;
              overflow-x: hidden;
            }
            body {
              font-family: ${font.family}, Arial, sans-serif;
              font-size: 24px;
              line-height: 1.28;
              padding: 12px 14px 24px 0px;
            }
            .center { text-align: center; }
            .left { text-align: left; }
            .right { text-align: right; }
            .bold, strong { font-weight: 400; }
            .large { font-size: 52px; }
            .brand { padding-bottom: 8px; }
            .brand--billing { text-align: left; }
            .masthead { display: flex; align-items: stretch; margin-bottom: 8px; }
            .masthead-logo {
              flex: 0 0 25%;
              display: flex;
              align-items: center;
              justify-content: center;
              border-right: 0px solid #8a8a8a;
              padding-right: 12px;
              margin-right: 16px;
            }
            .masthead-info { flex: 1 1 0; min-width: 0; padding: 2px 0; text-align: left; }
            .masthead--no-logo .masthead-info { flex-basis: 100%; }
            .identity {
              display: flex;
              justify-content: space-between;
              gap: 14px;
              margin-top: 10px;
              text-align: left;
              white-space: nowrap;
            }
            /* Unicode receipts are rasterized, so keep the two emphasized
               header values as separate, high-contrast boxes. This affects
               only the Sinhala/Tamil raster path; English stays ESC/POS. */
            .identity span {
              display: block;
              flex: 0 0 auto;
              min-width: 0;
              border: 4px solid #000;
              padding: 5px 8px;
              line-height: 1.12;
              overflow: hidden;
            }
            .identity span:empty {
              flex: 0 0 0;
              border: 0;
              padding: 0;
            }
            .identity span:last-child { text-align: right; }
            .logo {
              display: block;
              max-width: 260px;
              max-height: 138px;
              margin: 0 auto 7px;
              object-fit: contain;
            }
            .masthead-logo .logo { max-width: 118px; max-height: 128px; margin: 0; }
            .store { font-size: 44px; }
            .rule { border-top: 2px solid #000; margin: 8px 0; }
            .dash { border-top-style: dashed; }
            .meta, .total, .split {
              display: flex;
              justify-content: space-between;
              gap: 10px;
            }
            .meta span:first-child { font-weight: 600; }
            .items { border: 2px solid #000; }
            .item-title { padding: 4px 7px; border-bottom: 2px solid #000; }
            .measure-head, .measure-row {
              display: grid;
              grid-template-columns: 72px 16px 82px 18px 110px 1fr;
              gap: 0;
              padding: 4px 7px;
            }
            .measure-head { border-bottom: 2px solid #000; font-size: 19px; }
            .measure-item { border-bottom: 1px solid #000; }
            .measure-item:last-child { border-bottom: 0; }
            .description { padding: 5px 7px 0; font-weight: 600; }
            .measure-row { padding-top: 2px; padding-bottom: 5px; }
            .measure-row strong { text-align: right; }
            .small { padding: 0 7px 5px; font-size: 19px; }
            .total { padding: 4px 2px; }
            .grand {
              border-top: 2px solid #000;
              margin-top: 4px;
              padding-top: 6px;
              font-size: 26px;
            }
            .standard-item { padding: 5px 2px; border-bottom: 1px solid #000; }
            .standard-item:last-child { border-bottom: 0; }
          </style>
        </head>
        <body>
          <header class="brand ${billingMasthead ? "brand--billing" : "center"}">
            ${brandHeader}
            ${secondary}
          </header>

          <div class="rule"></div>

          ${meta ? `<section>${meta}</section><div class="rule dash"></div>` : ""}
          ${itemLayout}

          <div class="rule dash"></div>
          <section>${totals}</section>

          ${footer ? `<div class="rule dash"></div><footer>${footer}</footer>` : ""}
        </body>
      </html>`;
}

function waitForPaint(window) {
  return window.webContents.executeJavaScript(
    "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
  );
}

/**
 * Capture the whole receipt as one image. The window is first made exactly as
 * tall as the document, so this uses Electron's established capturePage path
 * without scrolling, overlapping viewports, or DevTools protocol dependency.
 */
async function captureContinuousReceipt(window, height) {
  window.setContentSize(RENDER_VIEWPORT_WIDTH, height);
  await waitForPaint(window);
  return window.webContents.capturePage({ x: 0, y: 0, width: RECEIPT_WIDTH, height });
}

function createReceiptRasterService() {
  function shouldRasterize(doc) {
    return normalizeReceiptLanguage(doc?.receiptLanguage) !== "en-LK";
  }

  async function render(doc) {
    const { BrowserWindow } = require("electron");
    if (!BrowserWindow)
      throw new Error(
        "Unicode receipt rendering is available only in the Electron desktop app.",
      );
    const window = new BrowserWindow({
      show: false,
      width: RENDER_VIEWPORT_WIDTH,
      height: INITIAL_RENDER_HEIGHT,
      frame: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        zoomFactor: 1,
      },
    });
    try {
      await window.loadURL(
        `data:text/html;charset=UTF-8,${encodeURIComponent(receiptHtml(doc))}`,
      );
      await waitForPaint(window);
      // body.scrollHeight is the actual receipt content (unlike
      // documentElement.scrollHeight, which includes the hidden viewport).
      const totalHeight = await window.webContents.executeJavaScript(
        "Math.ceil(document.body.scrollHeight)",
      );
      const fullReceipt = (await captureContinuousReceipt(window, totalHeight))
        // Windows display scaling can produce a higher-DPI image. Normalize
        // once, before cropping, so every strip shares exact pixel boundaries.
        .resize({ width: RECEIPT_WIDTH, quality: 'best' });
      const fullHeight = fullReceipt.getSize().height;
      const chunks = [];
      for (let top = 0; top < fullHeight; top += PRINTER_STRIP_HEIGHT) {
        const height = Math.min(PRINTER_STRIP_HEIGHT, fullHeight - top);
        chunks.push(fullReceipt.crop({ x: 0, y: top, width: RECEIPT_WIDTH, height }).toPNG());
      }
      return { width: RECEIPT_WIDTH, chunks };
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  return { shouldRasterize, render };
}

module.exports = { createReceiptRasterService, receiptHtml };
