// --- START OF FILE server.js (Cloudflare TTS URL 最终正确修复版) ---

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;

// --- 配置 Cloudinary (保持不变) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ----------------- AI 评分函数 (保持不变) -----------------
async function callAIScoringAPI(responseText, promptText) {
  // ... (此函数无需任何修改)
  console.log(
    "🤖 AI a commencé à noter avec le mode de pensée `deepseek-reasoner`..."
  );
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("❌ Erreur: DEEPSEEK_API_KEY non configuré.");
    throw new Error("AI service is not configured.");
  }
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert TOEFL writing evaluator. Your primary goal is to score a user's essay out of 30 points and provide high-quality, constructive feedback. To achieve this, you must follow a strict process: 1. First, think step-by-step inside a <thinking> block. Do not output the final JSON yet. 2. In your thinking process, analyze the user's response based on the following criteria: - Task Response: How well does the response address the prompt? Is the main idea clear and well-supported? - Organization & Development: Is the essay well-structured? Are ideas logically connected with good transitions? Are examples and details sufficient? - Language Use: How is the vocabulary and sentence structure? Is the grammar accurate? 3. Based on your analysis, determine a final overall score between 0 and 30. 4. Synthesize your key analysis points into concise, helpful feedback for the user. 5. After the <thinking> block, and only after, provide your final answer as a single JSON object in the specified format. Do not include any other text or markdown formatting around the JSON object.`;
  const userPrompt = `## PROMPT ##\n${promptText}\n\n## USER RESPONSE ##\n${responseText}`;

  try {
    const response = await axios.post(
      endpoint,
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    let aiResultContent = response.data.choices[0].message.content;
    const jsonMatch = aiResultContent.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("AI did not return a valid JSON object.");
    }
    const jsonString = jsonMatch[0];
    const result = JSON.parse(jsonString);
    console.log("✅ Notation DeepSeek AI (Reasoner) terminée !");
    return { score: result.score, feedback: result.feedback };
  } catch (error) {
    console.error(
      "❌ Erreur lors de l'appel à l'API DeepSeek:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to get a response from the AI service.");
  }
}
// -------------------------------------------------------------------------------------

// ======================= 【关键修正】后台音频生成函数 (使用Cloudflare) =======================
async function generateAudioIfNeeded(questionId) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    console.log("🔊 [Cloudflare] 音频生成跳过：环境变量未配置。");
    return;
  }

  try {
    const questionQuery = await pool.query(
      "SELECT lecture_script, lecture_audio_url, task_type FROM questions WHERE id = $1",
      [questionId]
    );
    const question = questionQuery.rows[0];
    if (
      !question ||
      question.task_type !== "integrated_writing" ||
      question.lecture_audio_url ||
      !question.lecture_script
    ) {
      return;
    }

    console.log(`🎤 [后台任务 CF-TTS] 开始为题目 #${questionId} 生成音频...`);

    // ====================== 【就是这里！已修正！】 ======================
    // 错误的 URL: /ai/run/@cf/microsoft/speecht5-tts
    // 正确的 URL: /ai/run/microsoft/speecht5-tts  (去掉了 @cf/)
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/microsoft/speecht5-tts`;
    // =================================================================

    const ttsResponse = await axios.post(
      endpoint,
      { text: question.lecture_script },
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer", // 接收音频文件流
      }
    );

    const audioBuffer = Buffer.from(ttsResponse.data);

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Cloudflare TTS 生成了空的音频 Buffer。");
    }

    // --- 后续上传到 Cloudinary 的逻辑保持不变 ---
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: "video", folder: "toefl_lectures" },
        (error, result) => {
          if (error) {
            console.error("❌ [后台任务] Cloudinary 上传失败:", error);
            return reject(error);
          }
          resolve(result);
        }
      );
      uploadStream.end(audioBuffer);
    });

    const uploadResult = await uploadPromise;
    const audioUrl = uploadResult.secure_url;
    await pool.query(
      "UPDATE questions SET lecture_audio_url = $1 WHERE id = $2",
      [audioUrl, questionId]
    );
    console.log(
      `✅ [后台任务 CF-TTS] 题目 #${questionId} 的音频已生成并保存: ${audioUrl}`
    );
  } catch (error) {
    const errorDetails = error.response
      ? JSON.parse(Buffer.from(error.response.data).toString())
      : error.message;
    console.error(
      `❌ [后台任务 CF-TTS] 为题目 #${questionId} 生成音频时出错:`,
      errorDetails
    );
  }
}
// =======================================================================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect((err) => {
  if (err) return console.error("❌ 数据库连接失败:", err);
  console.log("✅ 成功连接到 PostgreSQL 数据库！");
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(
    token,
    process.env.JWT_SECRET || "your_default_secret_key",
    (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    }
  );
};

// ======================= API 接口 (其余代码保持不变) =======================
// --- 生成音频的管理接口 ---
app.post("/api/generate-audio/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await generateAudioIfNeeded(id);
    const result = await pool.query(
      "SELECT lecture_audio_url FROM questions WHERE id = $1",
      [id]
    );
    if (result.rows.length > 0 && result.rows[0].lecture_audio_url) {
      res.json({
        message: "Audio generated successfully!",
        url: result.rows[0].lecture_audio_url,
      });
    } else {
      res
        .status(404)
        .json({ message: "Question not found or audio still processing." });
    }
  } catch (error) {
    console.error("Manual audio generation failed:", error);
    res.status(500).json({ message: "Failed to generate audio." });
  }
});

// --- 获取写作模拟考试 ---
app.get("/api/writing-test", async (req, res) => {
  try {
    const sql = `(SELECT * FROM questions WHERE task_type = 'integrated_writing' ORDER BY RANDOM() LIMIT 1) UNION ALL (SELECT * FROM questions WHERE task_type = 'academic_discussion' ORDER BY RANDOM() LIMIT 1);`;
    const result = await pool.query(sql);
    if (result.rows.length < 2)
      return res.status(404).json({
        message:
          "Not enough questions in database to start a full writing test.",
      });
    const integratedTask = result.rows.find(
      (q) => q.task_type === "integrated_writing"
    );
    if (integratedTask) {
      generateAudioIfNeeded(integratedTask.id);
    }
    res.json(result.rows);
  } catch (err) {
    console.error("获取写作考试题目失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 获取所有练习题目 ---
app.get("/api/questions", async (req, res) => {
  try {
    const sql = `SELECT id, title, topic, task_type FROM questions ORDER BY id`;
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error("获取题目列表失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 获取单个题目详情 ---
app.get("/api/questions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    generateAudioIfNeeded(id);
    const sql = `SELECT * FROM questions WHERE id = $1`;
    const result = await pool.query(sql, [id]);
    if (result.rows.length === 0)
      return res.status(404).json({ message: "题目未找到。" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`获取题目详情 ID ${id} 失败:`, err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 用户注册 ---
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "用户名和密码不能为空。" });
  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (userCheck.rows.length > 0)
      return res.status(409).json({ message: "用户名已存在。" });
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

// --- 用户登录 ---
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "用户名和密码不能为空。" });
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: "用户名或密码错误。" });
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch)
      return res.status(401).json({ message: "用户名或密码错误。" });
    const payload = { id: user.id, username: user.username };
    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || "your_default_secret_key",
      { expiresIn: "1d" }
    );
    res.json({
      message: "登录成功！",
      token,
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error("登录失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 提交作文 ---
app.post("/api/submit-response", authenticateToken, async (req, res) => {
  const { content, wordCount, questionId, task_type } = req.body;
  const userId = req.user.id;
  const qId = parseInt(questionId, 10);
  if ((!content && wordCount > 0) || !wordCount || isNaN(qId) || !task_type) {
    return res.status(400).json({ message: "请求缺少必要信息或格式不正确。" });
  }
  try {
    const sql = `INSERT INTO responses (content, word_count, question_id, task_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const result = await pool.query(sql, [
      content || "",
      wordCount,
      qId,
      task_type,
      userId,
    ]);
    const newResponseId = result.rows[0].id;
    res
      .status(201)
      .json({ message: "Submission successful!", id: newResponseId });
    (async () => {
      try {
        const questionRes = await pool.query(
          "SELECT * FROM questions WHERE id = $1",
          [qId]
        );
        const questionData = questionRes.rows[0];
        const promptText =
          questionData.task_type === "integrated_writing"
            ? `Reading: ${questionData.reading_passage}\nLecture: ${questionData.lecture_script}`
            : `Prompt: ${questionData.professor_prompt}\nStudent 1: ${questionData.student1_post}\nStudent 2: ${questionData.student2_post}`;
        const aiResult = await callAIScoringAPI(content || "", promptText);
        const updateSql = `UPDATE responses SET ai_score = $1, ai_feedback = $2 WHERE id = $3`;
        await pool.query(updateSql, [
          aiResult.score,
          aiResult.feedback,
          newResponseId,
        ]);
      } catch (aiError) {
        console.error(
          `❌ AI 评分失败 (Response ID: ${newResponseId}):`,
          aiError
        );
      }
    })();
  } catch (err) {
    console.error("数据库插入失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 获取历史列表 ---
app.get("/api/history", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT r.id, r.word_count, r.submitted_at, COALESCE(q.title, 'Archived Question') as question_title 
                     FROM responses r LEFT JOIN questions q ON r.question_id = q.id 
                     WHERE r.user_id = $1 ORDER BY r.submitted_at DESC;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("获取写作历史失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 获取历史详情 ---
app.get("/api/history/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const sql = `SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, r.ai_score, r.ai_feedback, q.* 
                 FROM responses r LEFT JOIN questions q ON r.question_id = q.id 
                 WHERE r.id = $1 AND r.user_id = $2;`;
  try {
    const result = await pool.query(sql, [id, userId]);
    if (result.rows.length === 0)
      return res.status(404).json({ message: "历史记录未找到或无权访问。" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`获取历史详情 ID ${id} 失败:`, err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 启动服务器 ---
app.use(express.static("public"));
app.listen(PORT, () => {
  console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});
