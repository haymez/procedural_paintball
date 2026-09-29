// Transient messages (copied link, errors) and the connection banner.

import type { ConnStatus } from "../net/connection";
import { h } from "./dom";

let host: HTMLElement | null = null;

export function toast(text: string, kind: "info" | "warn" | "good" = "info", ms = 3200): void {
  if (!host) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const t = h("div", { class: `toast ${kind === "info" ? "" : kind}` }, text);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Bottom banner shown while a room socket is down. */
export class ConnBanner {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly retry: HTMLButtonElement;

  constructor(onRetry: () => void) {
    this.text = h("span", null, "Reconnecting…");
    this.retry = h("button", { class: "btn small", type: "button", onclick: onRetry }, "Try now");
    this.el = h("div", { class: "conn-banner", role: "status", "aria-live": "polite", hidden: true }, h("i", { class: "dot" }), this.text, this.retry);
    document.body.append(this.el);
  }

  set(status: ConnStatus): void {
    const show = status === "reconnecting" || status === "offline";
    this.el.hidden = !show;
    this.text.textContent = status === "offline" ? "Can't reach the room. Still trying." : "Connection dropped. Reconnecting…";
    this.retry.hidden = status !== "offline";
  }

  dispose(): void {
    this.el.remove();
  }
}
