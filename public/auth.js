// ������������û��Ƿ��¼������̬���µ�����
function setupNavbar() {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    const navbar = document.querySelector('.navbar');

    if (!navbar) return; // ���ҳ��û�е���������ʲô������

    if (token && user) {
        // �û��ѵ�¼
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
        // �û�δ��¼
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/login.html" class="nav-link">Login</a>
                <a href="/register.html" class="nav-link">Sign Up</a>
            </div>
        `;
    }
}

// ��ÿ��ҳ�����ʱ���������������
document.addEventListener('DOMContentLoaded', setupNavbar);