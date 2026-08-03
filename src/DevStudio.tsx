import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";


/**
 * Dev-only annotation + live-tweak overlay. Never ships to production — see the
 * import.meta.env.DEV guard in Base.astro.
 *
 * Two modes. **View** leaves the page alone and adds a breakpoint switcher, so
 * the site can be checked at phone and desktop widths without a second device.
 * **Annotate** turns on the element picker: click anything to leave a note, or
 * drag a slider to preview a type change live, then "Copy brief" to paste a
 * Markdown summary into a Claude Code session.
 *
 * Notes accumulate per element rather than replacing each other. Clicking an
 * element you have already annotated shows what you said before and starts a
 * fresh note underneath — the same element usually collects several unrelated
 * remarks over a session, and folding them into one textarea meant the second
 * one silently overwrote the first.
 *
 * Switching to a new element while the previous one has unsaved slider changes
 * auto-reverts them, so the page doesn't accumulate stray live edits. See the
 * plan's Deferred / Open Questions section for the alternative.
 */

const STORAGE_KEY = "devstudio:annotations";
const RESET_MS = 1500;

/**
 * Type only. The layout sliders (padding, gap, margin) came out: a single
 * padding value written to all four sides, or a margin collapsed to one number,
 * described a change nobody would actually make, and the resulting brief line
 * ("padding: 24px → 31px") was never the real instruction. Type is different —
 * a size or a weight is genuinely one number, so the slider says something true.
 */
type StyleProperty = "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight";

const STYLE_PROPERTIES: StyleProperty[] = [
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
];

const PROP_LABEL: Record<StyleProperty, string> = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  letterSpacing: "letter-spacing",
  lineHeight: "line-height",
};

const WRITE_PROP: Record<StyleProperty, string> = PROP_LABEL;

/** Phone, laptop, desktop. Widths are viewport widths, so media queries in the
 *  framed page resolve exactly as they would on a real device of that size. */
const BREAKPOINTS = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "narrow", label: "Narrow", width: 1024, height: 768 },
  { id: "wide", label: "Wide", width: 1440, height: 900 },
] as const;

type BreakpointId = (typeof BREAKPOINTS)[number]["id"];

interface PropertyChange {
  property: StyleProperty;
  before: string;
  after: string;
}

interface Locator {
  tag: string;
  classes: string[];
  textExcerpt: string;
}

interface Annotation {
  id: string;
  page: string;
  locator: Locator;
  comment: string;
  changes: PropertyChange[];
  createdAt: string;
}

type Range = { min: number; max: number; step: number };

function loadAnnotations(): Annotation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAnnotations(list: Annotation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function locatorKey(locator: Locator, page: string) {
  return `${page}::${locator.tag}.${locator.classes.join(".")}::${locator.textExcerpt}`;
}

/** tag + classes + text excerpt, with fallbacks for textless elements and a
 * sibling-index tiebreaker when the locator collides with another element
 * currently on the page. */
function buildLocator(el: HTMLElement): Locator {
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList);
  const rawText = (el.textContent ?? "").trim().slice(0, 60);
  let textExcerpt = rawText;

  if (!textExcerpt) {
    const alt = el.getAttribute("alt") ?? el.querySelector("[alt]")?.getAttribute("alt") ?? null;
    const ariaLabel = el.getAttribute("aria-label");
    if (alt) {
      textExcerpt = `alt:${alt}`;
    } else if (ariaLabel) {
      textExcerpt = `aria-label:${ariaLabel}`;
    } else if (el.firstElementChild) {
      const child = el.firstElementChild;
      const childClass = child.classList[0];
      textExcerpt = childClass
        ? `${child.tagName.toLowerCase()}.${childClass}`
        : child.tagName.toLowerCase();
    }
  }

  let siblingIndex: number | null = null;
  const selector = classes.length ? `${tag}.${classes.join(".")}` : tag;
  try {
    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
      (candidate) => (candidate.textContent ?? "").trim().slice(0, 60) === rawText
    );
    if (matches.length > 1) siblingIndex = matches.indexOf(el);
  } catch {
    // invalid/unsupported selector -- skip disambiguation, base locator still works
  }

  return {
    tag,
    classes,
    textExcerpt: siblingIndex !== null ? `${textExcerpt} [#${siblingIndex + 1}]` : textExcerpt,
  };
}

/**
 * Whether the type sliders are worth showing. An element with no text of its
 * own renders nothing they could affect, and a wrapper div full of children
 * would have inherited font-size dragged onto it, which is almost never the
 * edit you want. Direct text nodes only — not descendant text.
 */
function hasOwnText(el: HTMLElement): boolean {
  return Array.from(el.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0
  );
}

function readInitialValue(el: HTMLElement, property: StyleProperty): number {
  const cs = getComputedStyle(el);
  switch (property) {
    case "fontSize":
      return parseFloat(cs.fontSize) || 16;
    case "fontWeight":
      return parseFloat(cs.fontWeight) || 400;
    case "letterSpacing":
      return cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
    case "lineHeight": {
      if (cs.lineHeight === "normal") return 1.2;
      if (cs.lineHeight.endsWith("px")) {
        const fontSize = parseFloat(cs.fontSize) || 16;
        return Math.round((parseFloat(cs.lineHeight) / fontSize) * 100) / 100;
      }
      return parseFloat(cs.lineHeight) || 1.2;
    }
  }
}

function rangeFor(property: StyleProperty, initial: number): Range {
  switch (property) {
    case "fontWeight":
      return { min: 100, max: 900, step: 100 };
    case "lineHeight":
      return { min: Math.max(0.8, initial - 0.8), max: initial + 0.8, step: 0.1 };
    case "letterSpacing":
      return { min: initial - 4, max: initial + 4, step: 0.1 };
    default: {
      const span = Math.max(initial, 8);
      return { min: Math.max(0, initial - span), max: initial + span, step: 1 };
    }
  }
}

function applyValue(el: HTMLElement, property: StyleProperty, value: number) {
  switch (property) {
    case "fontSize":
      el.style.fontSize = `${value}px`;
      break;
    case "fontWeight":
      el.style.fontWeight = String(value);
      break;
    case "letterSpacing":
      el.style.letterSpacing = `${value}px`;
      break;
    case "lineHeight":
      el.style.lineHeight = String(value);
      break;
  }
}

function formatValue(property: StyleProperty, value: number): string {
  return property === "fontWeight" || property === "lineHeight" ? String(value) : `${value}px`;
}

function groupByPage(annotations: Annotation[]): Map<string, Annotation[]> {
  const map = new Map<string, Annotation[]>();
  annotations.forEach((a) => {
    const list = map.get(a.page) ?? [];
    list.push(a);
    map.set(a.page, list);
  });
  return map;
}

function describeLocator(locator: Locator): string {
  const classPart = locator.classes.length ? `.${locator.classes.join(".")}` : "";
  return `${locator.tag}${classPart}`;
}

function buildMarkdown(annotations: Annotation[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# Studio notes — ${date}`, ""];
  groupByPage(annotations).forEach((list, page) => {
    lines.push(`## ${page}`);
    list.forEach((a) => {
      const excerptPart = a.locator.textExcerpt ? ` ("${a.locator.textExcerpt}")` : "";
      lines.push(`- **${describeLocator(a.locator)}**${excerptPart}`);
      if (a.comment) lines.push(`  Comment: ${a.comment}`);
      a.changes.forEach((c) => {
        lines.push(`  - ${PROP_LABEL[c.property]}: ${c.before} → ${c.after}`);
      });
      lines.push("");
    });
  });
  return lines.join("\n").trim() + "\n";
}

export default function DevStudio() {
  const [mode, setMode] = useState<"view" | "annotate">("view");
  const [breakpoint, setBreakpoint] = useState<BreakpointId | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [focusedEl, setFocusedEl] = useState<HTMLElement | null>(null);
  const [focusedRect, setFocusedRect] = useState<DOMRect | null>(null);
  const [touchedProps, setTouchedProps] = useState<Set<StyleProperty>>(new Set());
  const [values, setValues] = useState<Partial<Record<StyleProperty, number>>>({});
  const [ranges, setRanges] = useState<Partial<Record<StyleProperty, Range>>>({});
  const [comment, setComment] = useState("");
  const [showType, setShowType] = useState(false);
  const [isTrayOpen, setTrayOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [frameScale, setFrameScale] = useState(1);

  const baselineRef = useRef<Partial<Record<StyleProperty, string>>>({});
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setAnnotations(loadAnnotations());
  }, []);

  useEffect(
    () => () => {
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
    },
    []
  );

  // Grow the textarea to fit. Height is reset to auto first so it can shrink
  // again when text is deleted — scrollHeight never reports less than the
  // current height, so without the reset the box only ever gets taller.
  useLayoutEffect(() => {
    const el = commentRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [comment, focusedEl]);

  const isOwnUI = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest("[data-devstudio-ui]");

  const revertUnsavedEdits = useCallback((el: HTMLElement, touched: Set<StyleProperty>) => {
    touched.forEach((prop) => el.style.removeProperty(WRITE_PROP[prop]));
  }, []);

  const closeFocus = useCallback(() => {
    setFocusedEl(null);
    setFocusedRect(null);
    setTouchedProps(new Set());
    setValues({});
    setRanges({});
    setComment("");
    setShowType(false);
    baselineRef.current = {};
  }, []);

  const pickElement = useCallback(
    (el: HTMLElement) => {
      if (focusedEl && focusedEl !== el) {
        revertUnsavedEdits(focusedEl, touchedProps);
      }

      const baseline: Partial<Record<StyleProperty, string>> = {};
      const initialValues: Partial<Record<StyleProperty, number>> = {};
      const initialRanges: Partial<Record<StyleProperty, Range>> = {};
      STYLE_PROPERTIES.forEach((prop) => {
        const iv = readInitialValue(el, prop);
        baseline[prop] = formatValue(prop, iv);
        initialValues[prop] = iv;
        initialRanges[prop] = rangeFor(prop, iv);
      });

      baselineRef.current = baseline;
      setTouchedProps(new Set());
      setValues(initialValues);
      setRanges(initialRanges);
      // Always a blank note. Previous notes on this element render above it as
      // their own entries rather than being loaded in for editing.
      setComment("");
      setShowType(false);
      setFocusedEl(el);
      setFocusedRect(el.getBoundingClientRect());
      setHoverRect(null);
    },
    [focusedEl, touchedProps, revertUnsavedEdits]
  );

  useEffect(() => {
    if (mode !== "annotate") return;

    const handleMove = (e: MouseEvent) => {
      if (isOwnUI(e.target)) {
        setHoverRect(null);
        return;
      }
      setHoverRect((e.target as HTMLElement).getBoundingClientRect());
    };

    const handleClick = (e: MouseEvent) => {
      if (isOwnUI(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const target = e.target as HTMLElement;
      const el = e.altKey && target.parentElement ? target.parentElement : target;
      pickElement(el);
    };

    document.addEventListener("mousemove", handleMove, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("mousemove", handleMove, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [mode, pickElement]);

  useEffect(() => {
    if (!focusedEl) return;
    const update = () => setFocusedRect(focusedEl.getBoundingClientRect());
    const ro = new ResizeObserver(update);
    ro.observe(focusedEl);
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [focusedEl]);

  // Scale the framed preview down when the chosen width doesn't fit the real
  // window — 1440 rarely does once the browser's own chrome is accounted for.
  // Scaling rather than clipping keeps the whole layout visible, and the iframe
  // still *reports* the full width internally, so media queries are unaffected.
  useEffect(() => {
    if (!breakpoint) return;
    const target = BREAKPOINTS.find((b) => b.id === breakpoint);
    if (!target) return;

    const update = () => {
      const availableW = window.innerWidth - 64;
      const availableH = window.innerHeight - 128;
      setFrameScale(Math.min(1, availableW / target.width, availableH / target.height));
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [breakpoint]);

  /**
   * Esc switches modes.
   *
   * With a popover open it closes that first and leaves the mode alone. One
   * rule, and it protects a half-typed note — Esc is reflex for "get this panel
   * off my screen", and if that also flipped the mode the note would be gone.
   * A second press then switches, which is what a reflexive double-Esc expects
   * anyway.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (focusedEl) {
        handleCancel();
        return;
      }
      if (breakpoint) {
        setBreakpoint(null);
        return;
      }
      setModeSafely(mode === "view" ? "annotate" : "view");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleSliderChange = (prop: StyleProperty, value: number) => {
    if (!focusedEl) return;
    setTouchedProps((prev) => new Set(prev).add(prop));
    applyValue(focusedEl, prop, value);
    setValues((v) => ({ ...v, [prop]: value }));
  };

  const handleCancel = useCallback(() => {
    if (focusedEl) revertUnsavedEdits(focusedEl, touchedProps);
    closeFocus();
  }, [focusedEl, touchedProps, revertUnsavedEdits, closeFocus]);

  const handleSave = () => {
    if (!focusedEl) return;
    const page = window.location.pathname;
    const locator = buildLocator(focusedEl);
    const changes: PropertyChange[] = Array.from(touchedProps).map((prop) => ({
      property: prop,
      before: baselineRef.current[prop] ?? formatValue(prop, readInitialValue(focusedEl, prop)),
      after: formatValue(prop, values[prop] ?? readInitialValue(focusedEl, prop)),
    }));

    // Always a new entry. Merging into the existing one is what made a second
    // remark about the same element overwrite the first.
    const next: Annotation[] = [
      ...annotations,
      {
        id: crypto.randomUUID(),
        page,
        locator,
        comment,
        changes,
        createdAt: new Date().toISOString(),
      },
    ];

    setAnnotations(next);
    saveAnnotations(next);
    closeFocus();
  };

  const handleDelete = (id: string) => {
    setAnnotations((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveAnnotations(next);
      return next;
    });
  };

  const handleClearAll = () => {
    setAnnotations([]);
    saveAnnotations([]);
  };

  const handleCopyBrief = useCallback(async () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
    try {
      await navigator.clipboard.writeText(buildMarkdown(annotations));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    copyTimeout.current = setTimeout(() => setCopyStatus("idle"), RESET_MS);
  }, [annotations]);

  const setModeSafely = (next: "view" | "annotate") => {
    if (next === mode) return;
    if (focusedEl) handleCancel();
    setHoverRect(null);
    setMode(next);
    // The picker and the framed preview can't both own the pointer.
    if (next === "annotate") setBreakpoint(null);
  };

  const canSave = comment.trim().length > 0 || touchedProps.size > 0;

  const existingNotes = focusedEl
    ? (() => {
        const page = window.location.pathname;
        const key = locatorKey(buildLocator(focusedEl), page);
        return annotations.filter((a) => a.page === page && locatorKey(a.locator, page) === key);
      })()
    : [];

  const activeFrame = BREAKPOINTS.find((b) => b.id === breakpoint) ?? null;

  return (
    <div data-devstudio-ui className="devstudio">
      {/* ---- Toolbar ---------------------------------------------------- */}
      <div className="devstudio__bar">
        <div className="devstudio__modes" role="group" aria-label="Studio mode">
          <button
            type="button"
            className={`devstudio__mode${mode === "view" ? " is-active" : ""}`}
            aria-pressed={mode === "view"}
            onClick={() => setModeSafely("view")}
          >
            View
          </button>
          <button
            type="button"
            className={`devstudio__mode${mode === "annotate" ? " is-active" : ""}`}
            aria-pressed={mode === "annotate"}
            onClick={() => setModeSafely("annotate")}
          >
            Annotate
          </button>
        </div>

        <button
          type="button"
          className="devstudio__notes-btn"
          onClick={() => setTrayOpen((v) => !v)}
          aria-label={`Notes, ${annotations.length} saved`}
        >
          Notes
          {annotations.length > 0 && (
            <span className="devstudio__badge" aria-hidden="true">
              {annotations.length}
            </span>
          )}
        </button>
      </div>

      {/* Its own group in the opposite corner. Sharing the bottom bar with the
          mode switch meant the toolbar changed width every time the mode
          changed, which moved the Notes button out from under the pointer. */}
      {mode === "view" && (
        <div className="devstudio__bp-bar" role="group" aria-label="Preview width">
          {BREAKPOINTS.map((bp) => (
            <button
              key={bp.id}
              type="button"
              className={`devstudio__bp${breakpoint === bp.id ? " is-active" : ""}`}
              aria-pressed={breakpoint === bp.id}
              onClick={() => setBreakpoint((current) => (current === bp.id ? null : bp.id))}
              title={`${bp.label} — ${bp.width}px`}
            >
              {bp.label}
            </button>
          ))}
        </div>
      )}

      {/* ---- Breakpoint preview ----------------------------------------- */}
      {activeFrame && (
        <div className="devstudio__frame-backdrop">
          <div className="devstudio__frame-bar">
            <span>
              {activeFrame.label} · {activeFrame.width}×{activeFrame.height}
              {frameScale < 1 && ` · ${Math.round(frameScale * 100)}%`}
            </span>
            <button type="button" onClick={() => setBreakpoint(null)} aria-label="Close preview">
              ×
            </button>
          </div>
          {/* Two boxes on purpose. A transform doesn't change layout size, so a
              scaled stage still occupies its full unscaled height — which threw
              the flex centring out and pushed the top of the frame and its
              label off-screen. The outer box carries the *scaled* dimensions so
              the layout agrees with what's actually drawn. */}
          <div
            className="devstudio__frame-fit"
            style={{
              width: activeFrame.width * frameScale,
              height: activeFrame.height * frameScale,
            }}
          >
            <div
              className="devstudio__frame-stage"
              style={{
                width: activeFrame.width,
                height: activeFrame.height,
                transform: `scale(${frameScale})`,
              }}
            >
            {/* A real iframe, not a width-constrained div. Media queries answer
                to the viewport, so a narrowed element on a wide window still
                gets desktop CSS — which is exactly the thing being checked. */}
              <iframe
                title={`${activeFrame.label} preview`}
                src={`${window.location.pathname}${window.location.search ? `${window.location.search}&` : "?"}ds-preview=1`}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---- Picker ------------------------------------------------------ */}
      {mode === "annotate" && !focusedEl && hoverRect && (
        <div
          className="devstudio__highlight"
          style={{
            top: hoverRect.top,
            left: hoverRect.left,
            width: hoverRect.width,
            height: hoverRect.height,
          }}
        />
      )}

      {focusedEl && focusedRect && (
        <>
          <div
            className="devstudio__highlight"
            style={{
              top: focusedRect.top,
              left: focusedRect.left,
              width: focusedRect.width,
              height: focusedRect.height,
            }}
          />
          <div
            className="devstudio__popover"
            style={{
              top: Math.min(focusedRect.bottom + 8, window.innerHeight - 380),
              left: Math.min(Math.max(focusedRect.left, 8), window.innerWidth - 316),
            }}
          >
            <div className="devstudio__popover-head">
              <code>{describeLocator(buildLocator(focusedEl))}</code>
              <button type="button" onClick={handleCancel} aria-label="Close">
                ×
              </button>
            </div>

            {existingNotes.length > 0 && (
              <ul className="devstudio__existing">
                {existingNotes.map((note) => (
                  <li key={note.id}>
                    <span>{note.comment || <em>type change only</em>}</span>
                    <button
                      type="button"
                      onClick={() => handleDelete(note.id)}
                      aria-label="Delete this note"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <textarea
              ref={commentRef}
              className="devstudio__comment"
              placeholder={existingNotes.length > 0 ? "Add another note…" : "What's wrong with this?"}
              value={comment}
              rows={2}
              onChange={(e) => setComment(e.target.value)}
            />

            {/* Directly under the box it belongs to, rather than below the
                sliders — the note is the main thing here and the save was
                previously separated from it by everything else in the panel. */}
            <button
              type="button"
              className="devstudio__save"
              disabled={!canSave}
              onClick={handleSave}
            >
              Save note
            </button>

            {hasOwnText(focusedEl) &&
              (showType ? (
                <div className="devstudio__sliders">
                  {STYLE_PROPERTIES.map((prop) => {
                    const value = values[prop] ?? 0;
                    const range = ranges[prop] ?? { min: 0, max: 100, step: 1 };
                    return (
                      <div className="devstudio__slider-row" key={prop}>
                        <label>
                          <span>{PROP_LABEL[prop]}</span>
                          <span>{formatValue(prop, value)}</span>
                        </label>
                        <input
                          type="range"
                          min={range.min}
                          max={range.max}
                          step={range.step}
                          value={value}
                          onChange={(e) => handleSliderChange(prop, parseFloat(e.target.value))}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  className="devstudio__disclose"
                  onClick={() => setShowType(true)}
                >
                  Adjust type
                </button>
              ))}
          </div>
        </>
      )}

      {/* ---- Notes tray -------------------------------------------------- */}
      {isTrayOpen && (
        <div className="devstudio__tray">
          <div className="devstudio__tray-header">
            <h2>Studio notes</h2>
            <button type="button" onClick={() => setTrayOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="devstudio__tray-list">
            {annotations.length === 0 ? (
              <p className="devstudio__tray-empty">
                No notes yet — switch to Annotate and click something.
              </p>
            ) : (
              Array.from(groupByPage(annotations)).map(([page, list]) => (
                <div className="devstudio__tray-group" key={page}>
                  <h3>{page}</h3>
                  {list.map((a) => (
                    <div className="devstudio__tray-item" key={a.id}>
                      <button
                        type="button"
                        className="devstudio__tray-item-delete"
                        onClick={() => handleDelete(a.id)}
                        aria-label="Delete annotation"
                      >
                        ×
                      </button>
                      <div className="devstudio__tray-item-locator">
                        {describeLocator(a.locator)}
                        {a.locator.textExcerpt ? ` ("${a.locator.textExcerpt}")` : ""}
                      </div>
                      {a.comment && <div className="devstudio__tray-item-comment">{a.comment}</div>}
                      {a.changes.length > 0 && (
                        <ul className="devstudio__tray-item-changes">
                          {a.changes.map((c) => (
                            <li key={c.property}>
                              {PROP_LABEL[c.property]}: {c.before} → {c.after}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="devstudio__tray-footer">
            <button
              type="button"
              className="devstudio__copy"
              disabled={annotations.length === 0}
              onClick={handleCopyBrief}
            >
              {copyStatus === "copied"
                ? "Copied!"
                : copyStatus === "failed"
                  ? "Couldn't copy"
                  : "Copy brief"}
            </button>
            <button
              type="button"
              className="devstudio__clear"
              disabled={annotations.length === 0}
              onClick={handleClearAll}
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
