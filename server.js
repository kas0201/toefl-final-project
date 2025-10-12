const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 中间件设置 ---
app.use(cors());
app.use(express.json());

// ======================= 全新的 API 接口 =======================
//  API 1: 获取所有题目的列表 (用于练习中心)
// =============================================================
app.get('/api/questions', async (req, res) => {
    try {
        // 我们只选择 id, title, 和 topic，因为列表页不需要完整内容
        const result = await pool.query('SELECT id, title, topic FROM questions ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error("获取题目列表失败:", err);
        res.status(500).json({ message: "服务器内部错误，获取题目列表失败。" });
    }
});

// =============================================================
//  API 2: 根据 ID 获取某一道题目的完整内容 (用于练习页面)
// =============================================================
app.get('/api/questions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "题目未找到。" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(`获取题目 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误，获取题目详情失败。" });
    }
});


// --- 已有的 API 路由：处理提交作文的请求 ---
app.post('/api/submit-response', async (req, res) => {
    const { content, wordCount } = req.body;

    if (!content || wordCount === undefined) {
        return res.status(400).json({ message: "内容和字数不能为空。" });
    }

    const sql = `INSERT INTO responses (content, word_count) VALUES ($1, $2) RETURNING id`;

    try {
        const result = await pool.query(sql, [content, wordCount]);
        const newId = result.rows[0].id;
        console.log(`📝 一篇新作文已成功保存到数据库，ID为 ${newId}`);
        res.status(201).json({ message: "Submission successful!", id: newId });
    } catch (err) {
        console.error("数据库插入失败:", err);
        res.status(500).json({ message: "服务器内部错误，保存失败。" });
    }
});

// --- 静态文件服务 ---
app.use(express.static('public'));

// --- PostgreSQL 数据库连接 ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err) => {
    if (err) {
        return console.error('❌ 数据库连接失败:', err);
    }
    console.log('✅ 成功连接到 PostgreSQL 数据库！');
});

// --- 启动服务器 ---
app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});