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

        const testData = {
            testName: result.rows[0].test_name,
            sections: { reading: [], listening: [], speaking: [], writing: [] }
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

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "用户名和密码不能为空。" });
    }
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ message: "用户名已存在。" });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const sql = `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`;
        const newUser = await pool.query(sql, [username, hashedPassword]);
        res.status(201).json({ message: "注册成功！", user: newUser.rows[0] });
    } catch (err) {
        console.error("注册失败:", err);
        res.status(500).json({ message: "服务器内部错误。" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "用户名和密码不能为空。" });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ message: "用户名或密码错误。" });
        }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: "用户名或密码错误。" });
        }
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

app.post('/api/submit-response', authenticateToken, async (req, res) => {
    const { content, wordCount, questionId, task_type } = req.body;
    const userId = req.user.id;
    const qId = parseInt(questionId, 10);
    if (!content || !wordCount || isNaN(qId) || !task_type) {
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

app.use(express.static('public'));

app.listen(PORT, () => {
    console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});