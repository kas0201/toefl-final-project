const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- 数据库连接 ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) return console.error('❌ 数据库连接失败:', err);
    console.log('✅ 成功连接到 PostgreSQL 数据库！');
});

// --- 安检员 (中间件) ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(process.env.JWT_SECRET || 'your_default_secret_key', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// ======================= 公共 API (无需登录) =======================
app.get('/api/questions', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, title, topic FROM questions ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error("获取题目列表失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.get('/api/questions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "题目未找到。" });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`获取题目 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// ======================= 认证 API (用于登录注册) =======================
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "用户名和密码不能为空。" });
    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUser = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username", [username, password_hash]);
        res.status(201).json(newUser.rows[0]);
    } catch (err) {
        console.error("注册失败:", err);
        if (err.code === '23505') return res.status(409).json({ message: "用户名已存在。" });
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "用户名和密码不能为空。" });
    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ message: "用户名或密码错误。" });
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ message: "用户名或密码错误。" });
        const payload = { id: user.id, username: user.username };
        const token = jwt.sign(payload, process.env.JWT_SECRET || 'your_default_secret_key', { expiresIn: '1d' });
        res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err) {
        console.error("登录失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// ======================= 受保护的 API (需要安检) =======================
app.post('/api/submit-response', authenticateToken, async (req, res) => {
    const { content, wordCount, questionId, task_type = 'academic_discussion' } = req.body;
    const userId = req.user.id;
    const qId = parseInt(questionId, 10);
    if (!content || !wordCount || isNaN(qId)) return res.status(400).json({ message: "请求缺少必要信息或格式不正确。" });
    const sql = `INSERT INTO responses (content, word_count, question_id, task_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    try {
        const result = await pool.query(sql, [content, wordCount, qId, task_type, userId]);
        res.status(201).json({ message: "Submission successful!", id: result.rows[0].id });
    } catch (err) {
        console.error("数据库插入失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.get('/api/history', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const sql = `
            SELECT r.id, r.word_count, r.submitted_at, q.title as question_title 
            FROM responses r JOIN questions q ON r.question_id = q.id 
            WHERE r.user_id = $1 ORDER BY r.submitted_at DESC;`;
        const result = await pool.query(sql, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error("获取写作历史失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.get('/api/history/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const sql = `
        SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, q.* 
        FROM responses r JOIN questions q ON r.question_id = q.id 
        WHERE r.id = $1 AND r.user_id = $2;`;
    try {
        const result = await pool.query(sql, [id, userId]);
        if (result.rows.length === 0) return res.status(404).json({ message: "历史记录未找到或无权访问。" });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`获取历史详情 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- 静态文件服务 ---
app.use(express.static('public'));

// --- 启动服务器 ---
app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});