# Web content actions against Desktop parity

## Decision

Web should preserve Desktop's observable content actions wherever the browser has a standard equivalent:

- create text explicitly;
- select one or more files;
- accept file/text drops where the device offers drag and drop;
- accept user-initiated pasted text, images, and exposed files;
- upload and download directly against backend-prepared provider targets;
- open HTTP(S) links through normal browser navigation;
- copy text and decodable images after loading their bytes.

There are two unavoidable boundaries:

1. Web actions are page-scoped and user-initiated. A web page cannot reproduce Desktop's global clipboard capture or native filesystem access.
2. A normal web page cannot portably put an arbitrary named file onto the OS clipboard as a native file reference. For non-image files, the honest fallback is **Download**. A platform share sheet may be offered only when `navigator.canShare({ files })` confirms support; it is not a clipboard-parity contract.

No other UX divergence is justified by the evidence.

## Desktop baseline

Desktop already accepts authored text, file-picker selections, file/text drops, and native pasted text/images/files in `apps/desktop/src/renderer/views/Home.tsx`. Its copy action loads the managed bytes, writes text as text, images as native images, and other content as a materialized temporary file reference in `apps/desktop/src/main/index.ts` and `apps/desktop/src/main/clipboard.ts`. The closed issue [“Copying a file or image etc. should download it to a cache and actually copy the actual binary to user clipboard”](https://github.com/peterjarian/plakk/issues/37) confirms that copying the real content—not a provider URL—is intentional.

## Proven browser boundaries

### Explicit creation, selection, drop, and paste

`<input type="file" multiple>` is the portable file-selection path on desktop and mobile. The HTML standard requires a picker for file inputs and exposes selected names, types, and bodies as `File` objects. Paths remain hidden, which does not block direct upload. [HTML Standard: File Upload state](<https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)>)

Drag and drop exposes text and files through `DataTransfer`, but the specification deliberately leaves the physical gesture to the browser and input device. Treat drop as a supported enhancement, not the mobile happy path. [HTML Standard: Drag and drop](https://html.spec.whatwg.org/multipage/dnd.html)

A real user paste event exposes a `DataTransfer`; its `items` and `files` permit non-text content. The mandatory interoperable representations are plain text, HTML, and PNG, while other file types depend on what the OS/browser exposes. WebKit specifically exposes pasted native images as PNG files on macOS and iOS. Handle the synchronous `paste` event and fall back to the file picker when the clipboard does not expose a usable file. [Clipboard API specification](https://www.w3.org/TR/clipboard-apis/#clipboard-event-interfaces), [WebKit clipboard improvements](https://webkit.org/blog/8170/clipboard-api-improvements/)

### Direct provider upload and download

The existing provider shapes are compatible with browser-side byte transfer in principle:

- Google Drive documents resumable session URLs, chunked `PUT`s, `Content-Range`, and `308` responses with a `Range` acknowledgement. [Google Drive upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- OneDrive upload-session URLs accept sequential byte-range `PUT`s, and Microsoft explicitly documents OneDrive API CORS support for JavaScript apps. [Microsoft Graph upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0), [OneDrive CORS support](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/working-with-cors?view=odsp-graph-online)
- Dropbox's official JavaScript SDK documents one-use temporary upload links consumed by a binary `POST`, and temporary links for streaming downloads. [Dropbox JavaScript SDK](https://dropbox.github.io/dropbox-sdk-js/Dropbox.html)
- Google Drive supports authorized `alt=media` downloads; OneDrive explicitly requires JavaScript clients to use its preauthenticated `@microsoft.graph.downloadUrl`; Dropbox documents temporary streaming links. [Google Drive download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [Microsoft Graph JavaScript downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0#downloading-files-in-javascript-apps), [Dropbox JavaScript SDK](https://dropbox.github.io/dropbox-sdk-js/Dropbox.html)

The material browser-only constraint is CORS. `Authorization`, `Content-Range`, non-safelisted content types, and non-simple methods can trigger preflight; JavaScript can read a Google resumable upload's `Range` response only when the provider exposes it. Electron's `net.fetch` does not prove that these same targets work from a web origin. [Fetch Standard: CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol), [MDN: exposed response headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers)

Therefore direct transfer stays the happy path, but Web launch must verify all prepared upload/download targets from the production Web origin, including Google `Range` exposure. If a provider endpoint fails CORS, the backend must relay that provider's transfer; the product behavior should not be redesigned.

### Copy, download, and external links

Plain-text copy is portable in current browsers through `navigator.clipboard.writeText()` in a secure context and from an explicit user action. Images can be copied through `ClipboardItem`, with PNG as the interoperable image representation. WebKit supports only plain text, HTML, URI lists, and PNG in its documented implementation; current cross-browser guidance likewise names text, HTML, and PNG as commonly supported. Convert a decodable image to PNG when necessary and otherwise fall back to Download. [WebKit Async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/), [MDN: `Clipboard.write()`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write)

Copy must call `clipboard.write()` during the click/touch activation. `ClipboardItem` accepts promises for the representation, so provider download and image conversion can resolve after the browser has accepted the user-initiated write. This preserves Desktop's “click Copy, wait while bytes load, then copied” behavior without assuming that transient activation survives an arbitrary fetch. [WebKit Async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/)

The standard clipboard's mandatory types are text, HTML, and PNG; a `ClipboardItem` is a map of MIME representations and has no portable filename/native-path representation. Desktop's temporary-file clipboard formats (`NSFilenamesPboardType`, `CF_HDROP`, and URI lists) have no cross-browser Web equivalent. This is why generic file copy must become Download rather than silently copying raw MIME bytes that most target applications cannot paste as a named file. [Clipboard API specification](https://www.w3.org/TR/clipboard-apis/#mandatory-data-types)

Downloads are widely available through a same-origin or `blob:` link with the `download` attribute, but the filename is advisory and the browser/OS decides whether to prompt, save, preview, or open the resource. Mobile therefore gets the browser's download/save UI rather than Desktop's native clipboard file. [MDN: anchor `download`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)

External HTTP(S) links should remain explicit links, opened in a browser tab/navigation after the same warning decision used by Desktop. Web cannot force a separate default-browser application the way Electron's `shell.openExternal` can. Avoid delayed `window.open()` calls because popup blockers require direct user input. [HTML Standard: `noopener`](https://html.spec.whatwg.org/multipage/links.html#link-type-noopener), [MDN: `window.open()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)

## Web v1 acceptance boundary

Test current Chrome/Edge, Firefox, and Safari on desktop, plus Safari on iOS and Chrome on Android, for:

- file selection and explicit paste;
- desktop file/text drop;
- each provider's direct upload and download from the production Web origin;
- text copy and PNG image copy after an uncached provider fetch;
- generic-file Download with the expected filename;
- external-link confirmation and navigation.

Failure of generic file clipboard copy is accepted. Failure of any other listed action is a bug or a provider-transfer fallback requirement, not permission to invent a different product flow.
