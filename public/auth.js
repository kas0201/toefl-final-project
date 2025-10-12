// --- START OF FILE public/auth.js ---

document.addEventListener('DOMContentLoaded', () => {
    // Ѱ��ҳ���ϵĵ���������
    const navbar = document.querySelector('.navbar');
    if (!navbar) return; // ���ҳ����û�� .navbar����ʲôҲ����

    // �� localStorage ��ȡ�û���Ϣ
    const userString = localStorage.getItem('user');

    if (userString) {
        // ����û��ѵ�¼
        const user = JSON.parse(userString);
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/history.html" class="nav-link">History</a>
                <span class="nav-user">Hi, ${user.username}</span>
                <a href="#" id="logout-btn" class="nav-link" style="color: var(--accent-red);">Logout</a>
            </div>
        `;

        // �󶨵ǳ���ť�ĵ���¼�
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // �� localStorage ��� token ���û���Ϣ
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                // ��ת�ص�¼ҳ��
                window.location.href = '/login.html';
            });
        }
    } else {
        // ����û�δ��¼
        navbar.innerHTML = `
            <a href="/" class="nav-link">Practice Center</a>
            <div class="nav-right">
                <a href="/login.html" class="nav-link">Log In</a>
            </div>
        `;
    }
});