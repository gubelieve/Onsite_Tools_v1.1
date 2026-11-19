"use client"

import { useEffect } from "react"

/**
 * Keeps a toast readable while a modal dialog is open.
 *
 * Astryx's ToastViewport promotes itself into the top layer with
 * `popover="manual"`, once, on mount. A `<dialog>` opened later by `showModal()`
 * paints above it and the backdrop blurs the message out of readability — which
 * is the worst case rather than a cosmetic one, because nearly every failure in
 * this app is reported by a toast and the ones most worth reading are raised
 * from inside a dialog: a claim refused, a move rejected, an address already
 * held.
 *
 * MEASURED, because the obvious fixes do not work. Against a real modal dialog
 * in this app, with a probe that sets `pointer-events: auto` (the viewport sets
 * `none`, so a naive probe is invisible to elementFromPoint and every reading is
 * a false negative):
 *
 *   z-index: 2147483647 on the viewport      -> dialog still on top
 *   hidePopover() then showPopover()         -> dialog still on top
 *   moved inside the dialog, popover kept    -> dialog still on top
 *   moved inside the dialog, popover REMOVED -> toast on top
 *
 * Re-entering the top layer does not reorder against a modal dialog, and a
 * popover is its own top-layer entry, so being a DOM descendant of the dialog
 * changes nothing while the attribute is there. Both have to go together.
 * Astryx's own source anticipates this — `popover: isTopLayer ? 'manual' :
 * undefined`, commented "Omitted inside dialogs" — it just has no way to know a
 * dialog opened somewhere else in the tree.
 *
 * So: while any modal dialog is open the viewport is moved into the topmost one
 * with its popover attribute off, and put back exactly where React left it when
 * the last one closes.
 */
export function ToastAboveDialogs() {
  useEffect(() => {
    const SELECTOR = '[role="region"][aria-label="Notifications"]'

    // Where React put it. Restoring to the recorded parent matters: React
    // removes a node through its remembered parent, so leaving it somewhere
    // else would throw if the tree ever unmounts.
    let home: { parent: Node; next: Node | null } | null = null

    /**
     * Put it back, tolerating a stale sibling.
     *
     * The recorded `next` can be gone by the time the dialog closes — React
     * re-renders the body's children, and a dialog that unmounts takes its
     * subtree with it. `insertBefore` with a detached reference node throws
     * NotFoundError, which used to abort the restore half-done and strand the
     * viewport inside a dialog that was no longer on screen: no toast, anywhere,
     * for the rest of the session.
     */
    const putBack = (vp: HTMLElement, at: { parent: Node; next: Node | null }) => {
      const ref = at.next && at.next.parentNode === at.parent ? at.next : null
      try {
        at.parent.insertBefore(vp, ref)   // a null ref appends, which is the right fallback
      } catch {
        document.body.appendChild(vp)
      }
      vp.setAttribute("popover", "manual")
      try {
        vp.showPopover()
      } catch { /* already showing, or unsupported */ }
    }
    let movedTo: HTMLElement | null = null

    /**
     * Held rather than re-queried, and that is the whole safety of this.
     *
     * Parking the viewport inside a dialog ties its lifetime to that dialog: the
     * moment React unmounts the dialog, the viewport leaves the document with
     * it and `querySelector` returns null — so a version that looked it up each
     * time simply stopped finding it and never restored, leaving the app with NO
     * toasts at all for the rest of the session. That is strictly worse than the
     * bug being fixed, so the reference is kept and `document.contains` decides.
     */
    let viewport: HTMLElement | null = null

    const topmostDialog = () => {
      const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]
        // Only modal dialogs take the top layer; `show()` leaves a dialog in
        // normal flow, where the toast already paints correctly.
        .filter((d) => d.matches(":modal"))
      return open.length ? open[open.length - 1] : null
    }

    const sync = () => {
      const vp = viewport ?? document.querySelector<HTMLElement>(SELECTOR)
      if (!vp) return
      viewport = vp

      // Its host went away and took it along — put it back before anything else
      // reasons about where it should be.
      if (!document.contains(vp) && home) {
        putBack(vp, home)
        movedTo = null
        home = null
        return
      }

      const dialog = topmostDialog()

      if (dialog) {
        if (movedTo === dialog) return
        if (!home) home = { parent: vp.parentNode!, next: vp.nextSibling }
        try {
          if (vp.matches(":popover-open")) vp.hidePopover()
        } catch { /* not open, or unsupported */ }
        vp.removeAttribute("popover")
        dialog.appendChild(vp)
        movedTo = dialog
        return
      }

      if (!movedTo || !home) return
      putBack(vp, home)
      movedTo = null
      home = null
    }

    // Dialogs open and close by toggling `open`, and Astryx mounts and unmounts
    // the element itself, so both kinds of change have to be watched.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    })
    sync()

    return () => {
      observer.disconnect()
      // Leave the DOM as React expects it, whatever state a fast unmount caught
      // this in.
      if (viewport && movedTo && home) putBack(viewport, home)
    }
  }, [])

  return null
}
