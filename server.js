const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 中间件设置 ---
app.use(cors());
app.use(express.json());
// 直接从根目录托管 'public' 文件夹
app.use(express.static('public'));

// --- PostgreSQL 数据库连接 ---
// Render 会通过环境变量自动注入 DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// 检查数据库连接 (可选，但有助于调试)
pool.connect((err) => {
    if (err) {
        return console.error('❌ 数据库连接失败:', err);
    }
    console.log('✅ 成功连接到 PostgreSQL 数据库！');
});

// --- API 路由：处理提交作文的请求 ---
app.post('/api/submit-response', async (req, res) => {
    const { content, wordCount } = req.body;

    // 基本验证
    if (!content || wordCount === undefined) {
        return res.status(400).json({ message: "内容和字数不能为空。" });
    }

    const sql = `INSERT INTO responses (content, word_count) VALUES ($1, $2) RETURNING id`;

    try {
        const result = await pool.query(sql, [content, wordCount]);
        const newId = result.rows[0].id;
        console.log(`📝 一篇新作文已成功保存到数据库，ID为 ${newId}`);
        // 成功时，返回一个 JSON 对象
        res.status(201).json({ message: "作文已成功保存！", id: newId });
    } catch (err) {
        console.error("数据库插入失败:", err);
        // 失败时，也返回一个 JSON 对象
        res.status(500).json({ message: "服务器内部错误，保存失败。" });
    }
});

// --- 启动服务器 ---
app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});