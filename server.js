const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- API 1: 获取所有题目的列表 ---
app.get('/api/questions', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, title, topic FROM questions ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error("获取题目列表失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- API 2: 根据 ID 获取某一道题目的完整内容 ---
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

// --- API 3 (升级): 处理提交作文的请求 ---
app.post('/api/submit-response', async (req, res) => {
    const { content, wordCount, questionId, task_type = 'academic_discussion' } = req.body;

    // ============== 关键修正！确保 questionId 是一个整数 ==============
    const qId = parseInt(questionId, 10);
    // =============================================================

    if (!content || !wordCount || isNaN(qId)) { // 增加 isNaN 检查
        return res.status(400).json({ message: "请求缺少必要信息或格式不正确。" });
    }

    const sql = `INSERT INTO responses (content, word_count, question_id, task_type) VALUES ($1, $2, $3, $4) RETURNING id`;

    try {
        const result = await pool.query(sql, [content, wordCount, qId, task_type]);
        const newId = result.rows[0].id;
        console.log(`📝 一篇 [${task_type}] 作文已成功保存，ID为 ${newId}`);
        res.status(201).json({ message: "Submission successful!", id: newId });
    } catch (err) {
        console.error("数据库插入失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- API 4 (升级): 获取写作历史列表 ---
app.get('/api/history', async (req, res) => {
    try {
        // ============== 关键修正！使用 LEFT JOIN 增强查询的稳健性 ==============
        const sql = `
            SELECT 
                r.id, 
                r.task_type, 
                r.word_count, 
                r.submitted_at, 
                COALESCE(q.title, 'Unknown Question') as question_title 
            FROM 
                responses r 
            LEFT JOIN 
                questions q ON r.question_id = q.id 
            ORDER BY 
                r.submitted_at DESC;
        `;
        // ====================================================================
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("获取写作历史失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

// --- API 5: 获取写作历史详情 (已有) ---
app.get('/api/history/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `
            SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, q.* 
            FROM responses r JOIN questions q ON r.question_id = q.id 
            WHERE r.id = $1;`;
        const result = await pool.query(sql, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "历史记录未找到。" });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`获取历史详情 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) return console.error('❌ 数据库连接失败:', err);
    console.log('✅ 成功连接到 PostgreSQL 数据库！');
});

app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});