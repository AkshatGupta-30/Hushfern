# LocalGuardian

LocalGuardian is a Manifest V3 Chrome extension that classifies discussion text locally with `Xenova/toxic-bert` and softens content above your chosen toxicity threshold. After the model has been cached, classification stays on the device; analyzed text is not sent to an application server.

## Features

- Adjustable toxicity threshold from 40% to 80%.
- Adjustable blur intensity from 3px to 10px.
- Live analyzed and hidden-content counts for the active page.
- Safe asynchronous blur handling that ignores detached or replaced DOM nodes.
- Hover or keyboard reveal controls for reporting false positives and allowing a whole site.
- Exact-text and domain allowlists stored in `chrome.storage.local`.
- A private analytics page with recent trends, false-positive counts, and per-domain totals.
- Rolling 90-day analytics history stored only in the current Chrome profile.

## Build and load

Requires Node.js 20.19+ (or Node.js 22.12+).
LocalGuardian requires Chrome 116 or newer.

```powershell
yarn install
yarn build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` directory.

The first classification may take longer while the model assets are downloaded and cached. Later classifications use the cached model and WebGPU when available, with WASM as the fallback.

## Use

1. Open the LocalGuardian toolbar popup on a supported discussion page.
2. Move either slider; settings are saved immediately and applied to the current page.
3. Hover or focus a blurred paragraph to reveal it temporarily.
4. Choose **False positive** to allow that exact text, or **Always show on this site** to allow the current domain.
   If a site was allowed by mistake, use **Resume protection on this site** in the popup.
5. Open **View analytics** for locally stored historical trends.

## Supported pages

The bundled manifest currently injects LocalGuardian on Reddit, Hacker News, Stack Overflow, and configured `onlineviewer.net` subdomains. Add another match pattern in `public/manifest.json` when expanding support to a new site.

## Development

```powershell
yarn dev
```

This rebuilds the extension as source files change. Reload the extension from `chrome://extensions` after a rebuild so Chrome picks up the new bundle.
