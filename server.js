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
// ... (获取题目列表和详情的 API 保持不变)
app.get('/api/questions', async (req, res) => { /* ... */ });
app.get('/api/questions/:id', async (req, res) => { /* ... */ });


// ======================= 认证 API (用于登录注册) =======================
// ... (注册和登录的 API 保持不变)
app.post('/api/auth/register', async (req, res) => { /* ... */ });
app.post('/api/auth/login', async (req, res) => { /* ... */ });


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
        // 关键修正！使用 LEFT JOIN 增强查询的稳健性
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
    // 关键修正！同样使用 LEFT JOIN
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
app.use(express.static('public'));

// --- 启动服务器 ---
app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});