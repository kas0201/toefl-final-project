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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) return console.error('❌ 数据库连接失败:', err);
    console.log('✅ 成功连接到 PostgreSQL 数据库！');
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET || 'your_default_secret_key', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// ======================= 【新增 API】: 获取完整模拟考试数据 =======================
app.get('/api/tests/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `
            SELECT 
                t.name as test_name,
                tq.section,
                tq."order",
                q.*
            FROM tests t
            JOIN test_questions tq ON t.id = tq.test_id
            JOIN questions q ON tq.question_id = q.id
            WHERE t.id = $1
            ORDER BY tq.section, tq."order";
        `;
        const result = await pool.query(sql, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Test not found." });
        }

        // 将查询结果按科目分组
        const testData = {
            testName: result.rows[0].test_name,
            sections: {
                reading: [],
                listening: [],
                speaking: [],
                writing: []
            }
        };

        result.rows.forEach(row => {
            if (testData.sections[row.section]) {
                testData.sections[row.section].push(row);
            }
        });

        res.json(testData);

    } catch (err) {
        console.error(`获取考试 ID ${id} 失败:`, err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});


// (原有 API 保持不变，用于专项练习)
app.get('/api/questions', async (req, res) => {
    try {
        const sql = `SELECT id, title, topic, task_type FROM questions ORDER BY id`;
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("获取题目列表失败:", err);
        res.status(500).json({ message: "服务器内部错误，无法获取题目列表。" });
    }
});

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

// ... (认证和提交的API保持不变)
app.post('/api/auth/register', async (req, res) => { /* ... */ });
app.post('/api/auth/login', async (req, res) => { /* ... */ });
app.post('/api/submit-response', authenticateToken, async (req, res) => { /* ... */ });
app.get('/api/history', authenticateToken, async (req, res) => { /* ... */ });
app.get('/api/history/:id', authenticateToken, async (req, res) => { /* ... */ });


app.use(express.static('public'));

app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});