// Admin-only "Members" panel: create / manage guild member accounts.
import {
  listUsers, createUser, updateUser, resetUserPassword, deleteUser, setUserActive,
  changeMyPassword, getCurrentUser, backendCaps,
} from "../services/api";
import type { GuildUser } from "../types";

const caps = backendCaps();

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function openAdminPanel(): void {
  const me = getCurrentUser();
  let users: GuildUser[] = [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>👥 Guild Members</h2>
        <button class="btn small" data-close>✕ Close</button>
      </div>
      <div class="modal-body">
        <div class="admin-status" id="admin-status" hidden></div>
        ${caps.mode === "firebase" ? `<p class="note-sm" style="margin-top:0">Free Firebase plan: you can create members, set colours, grant/revoke admin and disable accounts. Members change their own password below; admin-initiated password resets need the Blaze plan.</p>` : ""}

        <section class="admin-section">
          <h3>Add a member</h3>
          <form id="createform" class="admin-form">
            <label class="field">Username<input name="username" required placeholder="e.g. SamR" /></label>
            <label class="field">Display name<input name="displayName" placeholder="Shown on the map" /></label>
            <label class="field">Password<input name="password" type="text" required placeholder="At least 6 characters" /></label>
            <label class="field">Map hook colour<input name="color" type="color" value="#5ee0a0" /></label>
            <label class="field check"><input name="isAdmin" type="checkbox" /> Make admin</label>
            <button class="btn primary" type="submit">＋ Create member</button>
          </form>
        </section>

        <section class="admin-section">
          <h3>Members</h3>
          <div id="userlist" class="userlist"><p class="muted">Loading...</p></div>
        </section>

        <section class="admin-section">
          <h3>Your account (${esc(me?.displayName ?? "")})</h3>
          <form id="pwform" class="admin-form">
            <label class="field">Current password<input name="current" type="password" required /></label>
            <label class="field">New password<input name="next" type="password" required /></label>
            <button class="btn" type="submit">Change my password</button>
          </form>
        </section>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector("#admin-status") as HTMLElement;
  function status(msg: string, bad = false): void {
    statusEl.textContent = msg;
    statusEl.hidden = false;
    statusEl.className = "admin-status " + (bad ? "bad" : "ok");
    if (!bad) window.setTimeout(() => { statusEl.hidden = true; }, 2600);
  }

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("[data-close]")!.addEventListener("click", close);

  function activeAdminCount(): number {
    return users.filter((u) => u.isAdmin && u.active !== false).length;
  }

  async function refresh(): Promise<void> {
    const listEl = overlay.querySelector("#userlist") as HTMLElement;
    try {
      users = await listUsers();
      listEl.innerHTML = users.map((u) => rowFor(u, me?.id)).join("");
      wireRows(listEl);
    } catch (err) {
      listEl.innerHTML = `<p class="login-error">${esc((err as Error).message)}</p>`;
    }
  }

  function rowFor(u: GuildUser, myId?: string | number): string {
    const isSelf = u.id === myId;
    const active = u.active !== false;
    const lastBtn = caps.hardDelete
      ? `<button class="btn small danger urow-del" ${isSelf ? "disabled" : ""}>Remove</button>`
      : `<button class="btn small ${active ? "danger" : ""} urow-active" data-active="${active ? "1" : "0"}" ${isSelf ? "disabled" : ""}>${active ? "Disable" : "Enable"}</button>`;
    return `<div class="userrow" data-id="${esc(String(u.id))}">
      <input type="color" class="urow-color" value="${esc(u.color)}" title="Hook colour" />
      <div class="urow-main">
        <div><b>${esc(u.displayName)}</b> <span class="muted">@${esc(u.username)}</span>
          ${u.isAdmin ? `<span class="badge live">admin</span>` : ""}
          ${!active ? `<span class="badge approx">disabled</span>` : u.online ? `<span class="badge live">● online</span>` : `<span class="badge">offline</span>`}
          ${isSelf ? `<span class="badge">you</span>` : ""}
        </div>
      </div>
      <label class="urow-admin check" title="Admin can manage members">
        <input type="checkbox" class="urow-isadmin" ${u.isAdmin ? "checked" : ""} ${isSelf ? "disabled" : ""}/> admin
      </label>
      ${caps.adminResetPassword ? `<button class="btn small urow-pw">Reset password</button>` : ""}
      ${lastBtn}
    </div>`;
  }

  function wireRows(listEl: HTMLElement): void {
    listEl.querySelectorAll<HTMLElement>(".userrow").forEach((row) => {
      const id = row.dataset.id!;
      const user = users.find((u) => String(u.id) === id);

      (row.querySelector(".urow-color") as HTMLInputElement).onchange = async (e) => {
        try {
          await updateUser(id, { color: (e.target as HTMLInputElement).value });
          status("Colour updated");
        } catch (err) { status((err as Error).message, true); }
      };

      (row.querySelector(".urow-isadmin") as HTMLInputElement).onchange = async (e) => {
        const cb = e.target as HTMLInputElement;
        if (!cb.checked && user?.isAdmin && activeAdminCount() <= 1) {
          cb.checked = true;
          status("Can't remove the last admin", true);
          return;
        }
        try {
          await updateUser(id, { isAdmin: cb.checked });
          status(cb.checked ? "Granted admin" : "Removed admin");
          refresh();
        } catch (err) {
          cb.checked = !cb.checked;
          status((err as Error).message, true);
        }
      };

      const pwBtn = row.querySelector(".urow-pw") as HTMLButtonElement | null;
      if (pwBtn) pwBtn.onclick = async () => {
        const pw = prompt("New password for this member:");
        if (!pw) return;
        try {
          await resetUserPassword(id, pw);
          status("Password reset");
        } catch (err) { status((err as Error).message, true); }
      };

      const delBtn = row.querySelector(".urow-del") as HTMLButtonElement | null;
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm("Remove this member? They will no longer be able to sign in.")) return;
        try {
          await deleteUser(id);
          status("Member removed");
          refresh();
        } catch (err) { status((err as Error).message, true); }
      };

      const activeBtn = row.querySelector(".urow-active") as HTMLButtonElement | null;
      if (activeBtn) activeBtn.onclick = async () => {
        const isActive = activeBtn.dataset.active === "1";
        if (isActive && user?.isAdmin && activeAdminCount() <= 1) {
          status("Can't disable the last admin", true);
          return;
        }
        if (isActive && !confirm("Disable this member? They won't be able to sign in until re-enabled.")) return;
        try {
          await setUserActive(id, !isActive);
          status(isActive ? "Member disabled" : "Member enabled");
          refresh();
        } catch (err) { status((err as Error).message, true); }
      };
    });
  }

  // create member
  (overlay.querySelector("#createform") as HTMLFormElement).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const get = (n: string) => (f.elements.namedItem(n) as HTMLInputElement);
    try {
      await createUser({
        username: get("username").value.trim(),
        displayName: get("displayName").value.trim(),
        password: get("password").value,
        color: get("color").value,
        isAdmin: get("isAdmin").checked,
      });
      f.reset();
      get("color").value = "#5ee0a0";
      status("Member created");
      refresh();
    } catch (err) { status((err as Error).message, true); }
  });

  // change my password
  (overlay.querySelector("#pwform") as HTMLFormElement).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const get = (n: string) => (f.elements.namedItem(n) as HTMLInputElement);
    try {
      await changeMyPassword(get("current").value, get("next").value);
      f.reset();
      status("Your password was changed");
    } catch (err) { status((err as Error).message, true); }
  });

  refresh();
}
