// --- START OF FILE server.js ---

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

    // 在验证时使用环境变量，并提供一个默认值以防万一
    jwt.verify(token, process.env.JWT_SECRET || 'your_default_secret_key', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// ======================= 公共 API (无需登录) =======================

// --- 【代码修正】: 实现了获取题目列表的 API ---
app.get('/api/questions', async (req, res) => {
    try {
        const sql = `SELECT id, title, topic FROM questions ORDER BY id`;
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("获取题目列表失败:", err);
        res.status(500).json({ message: "服务器内部错误，无法获取题目列表。" });
    }
});

// --- 【代码修正】: 实现了获取单个题目详情的 API ---
app.get('/api/questions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `SELECT * FROM questions WHERE id = $1`;
        const result = await pool.query(sql, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "题目未找到。" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`获取题目详情 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});


// ======================= 认证 API (用于登录注册) =======================

// --- 【代码修正】: 实现了用户注册的 API ---
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "用户名和密码不能为空。" });
    }

    try {
        // 检查用户名是否已存在
        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ message: "用户名已存在。" });
        }

        // 哈希密码
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 存入数据库
        const sql = `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`;
        const newUser = await pool.query(sql, [username, hashedPassword]);

        res.status(201).json({ message: "注册成功！", user: newUser.rows[0] });

    } catch (err) {
        console.error("注册失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- 【代码修正】: 实现了用户登录的 API ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "用户名和密码不能为空。" });
    }

    try {
        // 查找用户
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ message: "用户名或密码错误。" });
        }

        // 验证密码
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: "用户名或密码错误。" });
        }

        // 创建并签发 JWT
        const payload = { id: user.id, username: user.username };
        const token = jwt.sign(payload, process.env.JWT_SECRET || 'your_default_secret_key', { expiresIn: '1d' });

        res.json({
            message: "登录成功！",
            token,
            user: { id: user.id, username: user.username }
        });

    } catch (err) {
        console.error("登录失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});


// ======================= 受保护的 API (需要安检) =======================

// --- API (最终修正版): 处理提交作文的请求 ---
app.post('/api/submit-response', authenticateToken, async (req, res) => {
    const { content, wordCount, questionId, task_type = 'academic_discussion' } = req.body;
    const userId = req.user.id;

    // 关键修正！确保 questionId 是一个有效的整数
    const qId = parseInt(questionId, 10);
    if (!content || !wordCount || isNaN(qId)) {
        return res.status(400).json({ message: "请求缺少必要信息或格式不正确。" });
    }

    const sql = `INSERT INTO responses (content, word_count, question_id, task_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;

    try {
        const result = await pool.query(sql, [content, wordCount, qId, task_type, userId]);
        res.status(201).json({ message: "Submission successful!", id: result.rows[0].id });
    } catch (err) {
        console.error("数据库插入失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- API (最终修正版): 获取写作历史列表 ---
app.get('/api/history', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const sql = `
            SELECT 
                r.id, 
                r.word_count, 
                r.submitted_at, 
                COALESCE(q.title, 'Archived / Unknown Question') as question_title 
            FROM 
                responses r 
            LEFT JOIN 
                questions q ON r.question_id = q.id 
            WHERE 
                r.user_id = $1 
            ORDER BY 
                r.submitted_at DESC;
        `;
        const result = await pool.query(sql, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error("获取写作历史失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- API (最终修正版): 获取写作历史详情 ---
app.get('/api/history/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const sql = `
        SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, q.* 
        FROM responses r LEFT JOIN questions q ON r.question_id = q.id 
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
// 【重要】将所有HTML, JS, CSS文件放在一个名为 'public' 的文件夹中
app.use(express.static('public'));

// --- 启动服务器 ---
app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});