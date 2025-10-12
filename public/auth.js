// --- START OF FILE public/auth.js ---

document.addEventListener('DOMContentLoaded', () => {
    // 寻找页面上的导航栏容器
    const navbar = document.querySelector('.navbar');
    if (!navbar) return; // 如果页面上没有 .navbar，就什么也不做

    // 从 localStorage 获取用户信息
    const userString = localStorage.getItem('user');

    if (userString) {
        // 如果用户已登录
        const user = JSON.parse(userString);
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/history.html" class="nav-link">History</a>
                <span class="nav-user">Hi, ${user.username}</span>
                <a href="#" id="logout-btn" class="nav-link" style="color: var(--accent-red);">Logout</a>
            </div>
        `;

        // 绑定登出按钮的点击事件
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // 从 localStorage 清除 token 和用户信息
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                // 跳转回登录页面
                window.location.href = '/login.html';
            });
        }
    } else {
        // 如果用户未登录
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/login.html" class="nav-link">Log In</a>
            </div>
        `;
    }
});