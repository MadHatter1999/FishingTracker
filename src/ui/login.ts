import { login } from "../services/api";

// Full-screen gate shown until a guild member signs in.
export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  root.innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="loginform">
      <img class="login-logo" src="/fishing.png" alt="" width="84" height="84" />
      <h1 class="login-title">Nova Scotian Anglers Guild Project</h1>
      <p class="login-sub">Members only. Sign in to read the water, see your guild on the map, and get live conditions across Nova Scotia.</p>
      <label class="login-field">
        <span>Username</span>
        <input name="username" type="text" autocomplete="username" required autofocus />
      </label>
      <label class="login-field">
        <span>Password</span>
        <input name="password" type="password" autocomplete="current-password" required />
      </label>
      <div class="login-error" id="loginerror" hidden></div>
      <button class="btn primary login-btn" type="submit">Sign in</button>
      <p class="login-foot">No account yet? Ask your guild admin to create one for you.</p>
    </form>
  </div>`;

  const form = document.getElementById("loginform") as HTMLFormElement;
  const errEl = document.getElementById("loginerror")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    const username = (form.elements.namedItem("username") as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = "Signing in...";
    try {
      await login(username, password);
      onSuccess();
    } catch (err) {
      errEl.textContent = (err as Error).message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}
