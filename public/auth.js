// START OF FILE public/auth.js (Final Version with Navbar Layout Fix)

document.addEventListener("DOMContentLoaded", () => {
  const navbar = document.querySelector(".navbar");
  const user = JSON.parse(localStorage.getItem("user"));
  const token = localStorage.getItem("token");

  if (navbar) {
    // 【关键修复】: 构建完整的 navbar 结构，包含 nav-left 和 nav-right
    let navHTML = `
            <div class="nav-left">
                <a href="/writing-test.html" class="nav-link">Writing Test</a>
                <a href="/practice-center.html" class="nav-link">Practice Center</a>
            </div>
            <div class="nav-right">
        `;

    if (user && token) {
      // 已登录用户的右侧链接
      navHTML += `
                <a href="/dashboard.html" class="nav-link">Dashboard</a>
                <a href="/history.html" class="nav-link">History</a>
                <a href="/review-center.html" class="nav-link">Review Center</a>
                <a href="/mistake-book.html" class="nav-link">Mistake Book</a>
                <a href="/profile.html" class="nav-link">Hi, ${user.username}</a>
                <a href="#" id="logout-btn" class="nav-link">Logout</a>
            `;
    } else {
      // 未登录用户的右侧链接
      navHTML += `
                <a href="/login.html" class="nav-link">Login</a>
                <a href="/register.html" class="nav-link">Sign Up</a>
            `;
    }

    // 闭合 nav-right div
    navHTML += `</div>`;

    // 将完整的 HTML 结构注入 navbar
    navbar.innerHTML = navHTML;

    // 登出按钮的事件监听器保持不变
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", (e) => {
        e.preventDefault();
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/login.html";
      });
    }
  }
});
