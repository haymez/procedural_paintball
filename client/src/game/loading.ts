// Minimal loading card for the offline entry (the lobby has its own loading screen).
export interface Loading {
  progress(stage: string, t: number): void;
  done(): void;
}

export function showLoading(mount: HTMLElement, title: string): Loading {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;background:radial-gradient(120% 90% at 80% 0%,#fbe3a0,#fbf0d9 45%,#c4e9e2);z-index:50;font-family:Nunito,ui-rounded,system-ui,sans-serif;color:#23374b;transition:opacity .5s";
  el.innerHTML = `<div style="background:#fffaf0;border:3px solid #23374b;border-radius:1.6rem;box-shadow:0 .3rem 0 #23374b;padding:1.4rem 2rem;min-width:22rem;text-align:center">
    <div style="font-family:Fraunces,Georgia,serif;font-weight:900;font-size:2.2rem;line-height:1">${title}</div>
    <div class="st" style="margin:.6rem 0 .5rem;color:#566a7e;font-weight:700">waking the island…</div>
    <div style="height:14px;border:3px solid #23374b;border-radius:10px;overflow:hidden;background:#fff"><div class="bar" style="height:100%;width:0;background:#f47b63;transition:width .2s"></div></div>
  </div>`;
  mount.appendChild(el);
  const st = el.querySelector(".st") as HTMLElement, bar = el.querySelector(".bar") as HTMLElement;
  return {
    progress(stage, t) {
      st.textContent = stage.endsWith("…") ? stage : stage + "…";
      bar.style.width = Math.round(t * 100) + "%";
    },
    done() {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 600);
    },
  };
}
