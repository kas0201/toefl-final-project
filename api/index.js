const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// 关键改动：让服务器知道去哪里找 public 文件夹
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.post('/api/submit-response', async (req, res) => {
    const { content, wordCount } = req.body;
    if (!content || wordCount === undefined) {
        return res.status(400).json({ message: "内容和字数不能为空。" });
    }
    const sql = `INSERT INTO responses (content, word_count) VALUES ($1, $2) RETURNING id`;
    try {
        const result = await pool.query(sql, [content, wordCount]);
        res.status(201).json({ message: "作文已成功保存！", id: result.rows.id });
    } catch (err) {
        console.error("数据库插入失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});