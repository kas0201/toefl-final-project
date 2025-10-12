// 这个函数会检查用户是否登录，并动态更新导航栏
function setupNavbar() {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    const navbar = document.querySelector('.navbar');

    if (!navbar) return; // 如果页面没有导航栏，就什么都不做

    if (token && user) {
        // 用户已登录
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <span class="nav-user">Welcome, ${user.username}!</span>
                <a href="/history.html" class="nav-link">My History</a>
                <a href="#" id="logout-btn" class="nav-link">Logout</a>
            </div>
        `;

        document.getElementById('logout-btn').addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login.html';
        });
    } else {
        // 用户未登录
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/login.html" class="nav-link">Login</a>
                <a href="/register.html" class="nav-link">Sign Up</a>
            </div>
        `;
    }
}

// 在每个页面加载时，都运行这个函数
document.addEventListener('DOMContentLoaded', setupNavbar);