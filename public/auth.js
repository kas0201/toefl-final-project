// --- START OF FILE public/auth.js ---
document.addEventListener("DOMContentLoaded", () => {
  const navbar = document.querySelector(".navbar");
  if (!navbar) return;
  const userString = localStorage.getItem("user");
  if (userString) {
    const user = JSON.parse(userString);
    navbar.innerHTML = `<div><a href="/" class="nav-link">Writing Test</a><a href="/practice-center.html" class="nav-link" style="margin-left: 20px;">Practice Center</a></div><div class="nav-right"><a href="/history.html" class="nav-link">History</a><span class="nav-user">Hi, ${user.username}</span><a href="#" id="logout-btn" class="nav-link" style="color: var(--accent-red);">Logout</a></div>`;
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", (e) => {
        e.preventDefault();
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/login.html";
      });
    }
  } else {
    navbar.innerHTML = `<div><a href="/" class="nav-link">Writing Test</a><a href="/practice-center.html" class="nav-link" style="margin-left: 20px;">Practice Center</a></div><div class="nav-right"><a href="/login.html" class="nav-link">Log In</a></div>`;
  }
});
