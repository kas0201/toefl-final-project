// --- START OF FILE public/auth.js (with Profile link) ---
document.addEventListener("DOMContentLoaded", () => {
  const navbar = document.querySelector(".navbar");
  if (!navbar) return;
  const userString = localStorage.getItem("user");
  if (userString) {
    const user = JSON.parse(userString);
    navbar.innerHTML = `
      <div>
        <a href="/" class="nav-link">Writing Test</a>
        <a href="/practice-center.html" class="nav-link" style="margin-left: 20px;">Practice Center</a>
      </div>
      <div class="nav-right">
        <a href="/dashboard.html" class="nav-link">Dashboard</a>
        <a href="/history.html" class="nav-link">History</a>
        <a href="/review-center.html" class="nav-link">Review Center</a>
        <a href="/profile.html" class="nav-link" style="font-weight: 600;">Hi, ${user.username}</a>
        <a href="#" id="logout-btn" class="nav-link" style="color: var(--accent-red);">Logout</a>
      </div>`;
    // 我把用户名做成了个人中心的链接，并去掉了独立的 "Hi, ..." 文本
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
    navbar.innerHTML = `
      <div>
        <a href="/" class="nav-link">Writing Test</a>
        <a href="/practice-center.html" class="nav-link" style="margin-left: 20px;">Practice Center</a>
      </div>
      <div class="nav-right">
        <a href="/login.html" class="nav-link">Log In</a>
      </div>`;
  }
});
