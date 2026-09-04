# IFC Viewer — Grist custom widget

A Grist [custom widget](https://support.getgrist.com/widget-custom/) that
shows the 3D model attached to the selected row, using
[IFClite](https://ifclite.dev) (open-source, MPL-2.0) for parsing and
WebGPU rendering — no server, no build step, everything runs in the
browser tab.

The widget is structured as static files (`index.html`, `styles.css`, `app.js`). There's nothing to install or compile.

## 1. Set up your Grist table

Add a column of type **Attachments** to the table you want to browse
models from (e.g. `IfcFile`), and attach an `.ifc` file to a row.

## 2. Host `index.html` somewhere

Grist loads custom widgets from a URL, so `index.html` needs to be
reachable over HTTPS. Any static host works, for example:

- **GitHub Pages** — push this folder to a repo, enable Pages, and use
  the resulting `https://<user>.github.io/<repo>/index.html` URL.
- **Netlify / Vercel / Cloudflare Pages** — drag-and-drop deploy of this
  folder works fine.
- **Self-hosted Grist** — if your instance allows it, add the URL to
  the [widget allow-list](https://support.getgrist.com/self-managed/#widgets),
  or serve it from the same origin.

## 3. Add the widget in Grist

1. Open the page you want to add it to, click **Add New → Add Widget to
   Page**, and choose **Custom** as the widget type.
2. Choose **Custom URL** and paste the URL from step 2.
3. When prompted for access, choose **Read table** (the widget needs
   this to download attachment files).
4. In the widget's column-mapping panel, map **IFC model file** to
   your Attachments column.

Select a row with a model attached, and it should load automatically.

## Using the viewer

- **Drag** to orbit, **scroll** to zoom, **shift-drag** (or middle/right
  mouse drag) to pan, **Fit view** to re-frame the model.
- **Open file…** lets you preview any local `.ifc` file, regardless of
  what's mapped in Grist — handy for testing the widget on its own, or
  for a quick look at a file before attaching it to a row.
- If a row's Attachments cell holds more than one file, only the first
  one is shown.

## Notes and limitations

- **Browser support**: needs WebGPU — recent Chrome or Edge (113+),
  Firefox (127+), or Safari (18+). Older browsers will show a clear
  error instead of a blank canvas.
- **Everything is client-side**: the whole file is downloaded, parsed,
  and tessellated in the visitor's browser tab. That's fine for typical
  model sizes, but very large IFC files (hundreds of MB) will be slow
  and memory-hungry, since there's no server-side pre-processing. If
  that becomes a problem, IFClite also has a
  [server component](https://ifclite.dev/docs/guide/server/)
  (`@ifc-lite/server-client`) that can do the parsing/caching centrally
  — worth adding if you outgrow the fully client-side setup.
- **Unpinned CDN imports**: `index.html` loads IFClite from jsDelivr
  without a version pin (`@ifc-lite/parser/+esm`, etc.), matching
  IFClite's own quick-start docs. That means it always tracks the
  latest release, which is convenient but not fully reproducible. For
  a production rollout, pin versions instead, e.g.:
  ```
  https://cdn.jsdelivr.net/npm/@ifc-lite/parser@3.3.0/+esm
  ```
  and keep the `parser` / `geometry` / `renderer` / `wasm` versions in
  step with each other (check current numbers at
  [npmjs.com/org/ifc-lite](https://www.npmjs.com/org/ifc-lite)).
- Only single-model viewing is wired up here. IFClite also supports
  multi-model federation, BCF issue tracking, and IDS validation if you
  want to extend this widget later — see the
  [IFClite docs](https://ifclite.dev/docs/) for those APIs.

## How it works, in short

1. `grist.onRecord` fires whenever the selected row changes.
2. The widget reads the mapped Attachments column, and uses
   `grist.docApi.getAccessToken()` to fetch the file's bytes straight
   from Grist's document API.
3. `@ifc-lite/parser` parses the IFC data, `@ifc-lite/geometry`
   tessellates it (via WASM), and `@ifc-lite/renderer` draws it with
   WebGPU on a `<canvas>`.
4. Mouse events drive the camera through IFClite's `camera.orbit` /
   `.pan` / `.zoom` methods.

Dropping a local file, or clicking **Open file…**, runs the same
`loadIfcBuffer()` pipeline, just skipping the Grist download step.
