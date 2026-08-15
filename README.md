# Hushfern

Hushfern is a Manifest V3 Chrome extension that creates a calmer layer for the web. It classifies readable website text locally with a pinned `Xenova/toxic-bert` model and softens content above your chosen toxicity threshold. The release build packages the hash-verified model with the extension, remote model loading is disabled, and analyzed text never leaves the device.

## Features

- Adjustable toxicity threshold from 40% to 80%.
- Adjustable blur intensity from 3px to 10px.
- Explicit first-run consent before any webpage text is analyzed.
- Live analyzed and hidden-content counts for the active page.
- Safe asynchronous blur handling that ignores detached or replaced DOM nodes.
- Optional hover reveal, with keyboard focus reveal always available.
- A private analytics page with recent trends and per-domain totals.
- Rolling 90-day analytics history stored only in the current Chrome profile.

## Build and load

Requires Node.js 20.19+ (or Node.js 22.12+).
Hushfern requires Chrome 116 or newer.

```powershell
yarn install
yarn build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` directory.

The first clean build downloads the pinned fp32 model revision once, verifies every file's SHA-256, and copies it into `dist`. Installed builds never fetch model artifacts at runtime. Classification uses WebGPU when available, with the packaged WASM runtime as the fallback.

## Use

1. Review the first-run disclosure and choose **Enable protection**. Until then, Hushfern remains dormant.
2. Open any normal HTTP or HTTPS website, then open the Hushfern toolbar popup.
3. Move either slider; settings are saved immediately and applied to the current page.
4. Hover or focus a blurred paragraph to reveal it temporarily.
5. Open **View protection history** for locally stored historical trends.

You can review or revoke consent at any time from **Privacy & consent** in the popup. Turning protection off stops new analysis and restores content currently blurred by Hushfern.

## Website access

Hushfern runs on every HTTP and HTTPS website. Chrome will therefore show the standard permission notice that the extension can read and change site content. Browser-owned pages such as `chrome://extensions`, the Chrome Web Store, and other protected URLs do not permit content-script injection and cannot be moderated by extensions.

## Development

```powershell
yarn dev
```

This rebuilds the extension as source files change. Reload the extension from `chrome://extensions` after a rebuild so Chrome picks up the new bundle.
