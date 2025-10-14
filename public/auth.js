// START OF FILE public/auth.js (Final Version with Navbar Layout Fix)

document.addEventListener("DOMContentLoaded", () => {
  // 【关键修复】: 动态注入一个 <style> 标签来统一修复所有页面的导航栏布局。
  // 这可以确保左右两侧的链接都有正确的间距，而无需修改每一个 HTML 文件。
  const style = document.createElement("style");
  style.innerHTML = `
    .nav-left, .nav-right {
        display: flex;
        align-items: center;
        gap: 20px; /* 为链接之间提供 20px 的间距 */
    }
  `;
  document.head.appendChild(style);

  const navbar = document.querySelector(".navbar");
  const user = JSON.parse(localStorage.getItem("user"));
  const token = localStorage.getItem("token");

  if (navbar) {
    // 构建完整的 navbar 结构，包含 nav-left 和 nav-right
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
