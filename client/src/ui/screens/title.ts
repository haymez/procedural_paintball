// Title: the poster, and a ferry ticket with your name and the ways in.

import { NAME_MAX, normalizeCode, randomPlayerName, sanitizeName } from "../../../../shared/net/index";
import { prefs } from "../../net/session";
import { blobSvg, colorHex, heroPoster, icons } from "../art";
import { h, html } from "../dom";

export interface TitleActions {
  quickPlay(): Promise<void>;
  createRoom(): Promise<void>;
  joinCode(code: string): Promise<string | null>; // returns an error message or null
  browse(): void;
  /** Offline game against bots. */
  practice(): void;
}

export function titleScreen(actions: TitleActions): HTMLElement {
  const nameInput = h("input", {
    class: "input",
    id: "player-name",
    maxlength: String(NAME_MAX),
    autocomplete: "nickname",
    spellcheck: "false",
    value: prefs.name,
  });
  const avatar = html(blobSvg(colorHex(prefs.color >= 0 ? prefs.color : 0), { size: 60, cls: "avatar" }));

  const commitName = () => {
    const n = sanitizeName(nameInput.value);
    if (n) prefs.name = n;
    else nameInput.value = prefs.name;
  };
  nameInput.addEventListener("change", commitName);
  nameInput.addEventListener("blur", commitName);

  const reroll = h(
    "button",
    {
      class: "btn icon-only",
      type: "button",
      title: "Pick a random name",
      "aria-label": "Pick a random name",
      onclick: () => {
        const n = randomPlayerName(Math.random);
        nameInput.value = n;
        prefs.name = n;
      },
    },
    html(icons.dice),
  );

  const codeInput = h("input", {
    class: "input code",
    id: "join-code",
    maxlength: "4",
    placeholder: "ABCD",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "join-error",
    "aria-label": "Room code",
  });
  const codeError = h("p", { class: "field-error", id: "join-error", role: "alert" });

  const busy = (btn: HTMLButtonElement, fn: () => Promise<unknown>) => async () => {
    if (btn.disabled) return;
    commitName();
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      codeError.textContent = "Couldn't reach the harbour. Check your connection and try again.";
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  };

  const playBtn = h("button", { class: "btn primary", type: "button", id: "btn-play" }, "Play now");
  playBtn.addEventListener("click", busy(playBtn, () => actions.quickPlay()));
  const createBtn = h("button", { class: "btn sea", type: "button", id: "btn-create" }, "Create room");
  createBtn.addEventListener("click", busy(createBtn, () => actions.createRoom()));
  const browseBtn = h("button", { class: "btn sun", type: "button", id: "btn-browse", onclick: () => actions.browse() }, "Browse rooms");
  const practiceBtn = h("button", { class: "btn", type: "button", id: "btn-practice", onclick: () => { commitName(); actions.practice(); } }, "Practice with bots");

  const joinBtn = h("button", { class: "btn", type: "submit", id: "btn-join" }, "Join");
  const joinForm = h(
    "form",
    { class: "field", novalidate: true },
    h("label", { htmlFor: "join-code" }, "Have a code?"),
    h("div", { class: "join-code" }, codeInput, joinBtn),
    codeError,
  );
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    codeError.textContent = "";
  });
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = normalizeCode(codeInput.value);
    if (!code) {
      codeError.textContent = "Codes are 4 letters or digits, like K7QX.";
      codeInput.focus();
      return;
    }
    void busy(joinBtn, async () => {
      const err = await actions.joinCode(code);
      if (err) {
        codeError.textContent = err;
        codeInput.focus();
      }
    })();
  });

  const poster = h(
    "div",
    { class: "poster" },
    html(heroPoster()),
    h(
      "div",
      { class: "poster-title" },
      h("h1", { class: "wordmark" }, "Isola"),
      h("p", { class: "poster-tag" }, "Paintball on a sunny island, up to twenty at a time"),
    ),
    h("div", { class: "poster-foot", "aria-hidden": "true" }, h("span", null, "Riviera di Levante"), h("span", null, "Traghetti ogni ora")),
  );

  const ticket = h(
    "div",
    { class: "ticket-frame" },
    h(
      "section",
      { class: "ticket boarding", "aria-labelledby": "board-title" },
      h(
        "div",
        { class: "boarding-head" },
        avatar,
        h("h2", { class: "display", id: "board-title" }, "Who's coming aboard?"),
      ),
      h("div", { class: "field" }, h("label", { htmlFor: "player-name" }, "Your name"), h("div", { class: "name-row" }, nameInput, reroll)),
      h("div", { class: "play-stack" }, playBtn, h("div", { class: "split" }, createBtn, browseBtn), practiceBtn),
      h("hr", { class: "divider-wave" }),
      joinForm,
    ),
  );

  const el = h(
    "main",
    { class: "title-screen" },
    poster,
    h(
      "div",
      { class: "title-side" },
      ticket,
      h("p", { class: "title-foot" }, "Play now drops you into an open public room, or starts one."),
    ),
  );
  return el;
}
