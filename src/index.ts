import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import DevStudio from "./DevStudio";
// ?inline gives the stylesheet as a string instead of emitting a sidecar file,
// which is what keeps the build to one artefact. A bookmarklet has nowhere to
// put a second file, and a <script> tag shouldn't need one.
import css from "./dev-studio.css?inline";

const MOUNT_ID = "devstudio-root";
const STYLE_ID = "devstudio-style";

/** The overlay's own breakpoint iframe loads the page with this flag. Mounting
 *  inside it would draw a second toolbar over the preview, and that copy could
 *  open a third iframe inside itself. */
function isInsideOwnPreview(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("ds-preview");
  } catch {
    return false;
  }
}

let root: Root | null = null;

/**
 * Mounts the overlay. Safe to call more than once — a second call is a no-op
 * rather than a second toolbar, because the three delivery routes can overlap
 * (a project with the devDependency where the bookmarklet also gets clicked).
 */
export function mountDevStudio(): void {
  if (typeof document === "undefined") return;
  if (isInsideOwnPreview()) return;
  if (document.getElementById(MOUNT_ID)) return;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  const host = document.createElement("div");
  host.id = MOUNT_ID;
  document.body.appendChild(host);

  root = createRoot(host);
  root.render(createElement(DevStudio));
}

/** Mostly for the bookmarklet, where clicking it twice should toggle rather
 *  than stack. */
export function unmountDevStudio(): void {
  root?.unmount();
  root = null;
  document.getElementById(MOUNT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

/** True when the overlay is currently on the page. */
export function isDevStudioMounted(): boolean {
  return !!document.getElementById(MOUNT_ID);
}

/**
 * Auto-mount on load.
 *
 * Loading this file at all is the opt-in — a <script> tag, a bookmarklet, or an
 * import already behind the consumer's own dev guard. Deciding here whether the
 * environment "looks like development" would be guessing, and it would break
 * the bookmarklet, whose entire point is running on a site that is very much in
 * production.
 *
 * The one thing that is checked is the preview flag, above.
 */
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountDevStudio(), { once: true });
  } else {
    mountDevStudio();
  }
}
