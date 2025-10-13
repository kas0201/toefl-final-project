// --- START OF FILE server.js (Strict TOEFL Rubric Scoring) ---

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");

// --- 配置 Cloudinary (保持不变) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ======================= 【核心升级】全新AI评分函数 =======================
async function callAIScoringAPI(responseText, promptText, taskType) {
  console.log(
    `🤖 AI a commencé à noter (Mode: ${taskType}) avec le mode de pensée deepseek-reasoner...`
  );
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("❌ Erreur: DEEPSEEK_API_KEY non configuré.");
    throw new Error("AI service is not configured.");
  }
  const endpoint = "https://api.deepseek.com/chat/completions";

  // === 全新的、严格遵循托福官方评分标准的系统指令 ===
  const systemPrompt = `You are an expert ETS-trained evaluator for the TOEFL iBT Writing section. Your evaluation must strictly adhere to the official scoring rubrics.

    Your process is as follows:
    1.  **Identify Task Type**: First, identify the task type from the user prompt ('Integrated Writing' or 'Academic Discussion').
    2.  **Apply Correct Rubric**: In a <thinking> block, analyze the user's response strictly according to the specific rubric for that task type provided below.
    3.  **Holistic Scoring**: Based on your rubric-based analysis, determine a holistic overall score from 0-30.
    4.  **Structured Feedback**: Generate concise, constructive feedback for each category within the official rubric.
    5.  **Final JSON Output**: After the <thinking> block, provide your final answer ONLY as a single, valid JSON object in the specified format.

    ---
    ### Integrated Writing Task Rubric ###
    If the task is 'Integrated Writing', use these criteria:
    - **Task Response (Selection & Connection)**: How accurately and completely does the response select the important information from the lecture and explain how it challenges or supports the points in the reading passage? A high-scoring response must clearly connect lecture points to reading points.
    - **Organization & Development**: Is the response well-organized with a clear structure (e.g., introduction, body paragraphs for each point)? Are the ideas logically connected?
    - **Language Use**: How effectively is language used? Consider grammar, vocabulary, and sentence structure. Minor errors are acceptable if the meaning is clear.

    ### Academic Discussion Task Rubric ###
    If the task is 'Academic Discussion', use these criteria:
    - **Task Response (Contribution)**: Does the response make a relevant and clear contribution to the discussion? Does it directly address the professor's question and engage with the other students' ideas?
    - **Organization & Development**: Is the main idea clearly stated? Is it well-supported with reasons, details, and/or examples? Is the response easy to follow?
    - **Language Use**: Is the language clear and idiomatic? Does it demonstrate a good range of vocabulary and sentence structures?
    ---

    **JSON Output Format:**
    {
      "overallScore": <integer from 0 to 30>,
      "feedback": {
        "taskResponse": { "rating": "<string>", "comment": "<string>" },
        "organization": { "rating": "<string>", "comment": "<string>" },
        "languageUse": { "rating": "<string>", "comment": "<string>" },
        "generalSuggestion": "<string>"
      }
    }
    `;

  const taskTypeName =
    taskType === "integrated_writing"
      ? "Integrated Writing"
      : "Academic Discussion";
  const userPrompt = `## TASK TYPE ##\n${taskTypeName}\n\n## PROMPT ##\n${promptText}\n\n## USER RESPONSE ##\n${responseText}`;

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
    console.log("✅ Notation DeepSeek AI (Rubric-based) terminée !");
    return {
      score: result.overallScore,
      feedback: JSON.stringify(result.feedback),
    };
  } catch (error) {
    console.error(
      "❌ Erreur lors de l'appel à l'API DeepSeek:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to get a response from the AI service.");
  }
}
// =======================================================================

// --- 增加停顿以控制语速的辅助函数 (保持不变) ---
function addPausesToText(text) {
  if (!text) return "";
  let processedText = text;
  processedText = processedText.replace(/\./g, ". ... ");
  processedText = processedText.replace(/\n/g, ". ... ... \n");
  return processedText;
}

// --- 使用 Cloudflare Aura 的音频生成函数 (保持不变) ---
async function generateAudioIfNeeded(questionId) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    console.log("🔊 [Cloudflare TTS] 音频生成跳过：环境变量未配置。");
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

    console.log(
      `🎤 [后台任务 CF-Aura-TTS] 开始为题目 #${questionId} 生成音频...`
    );
    const textWithPauses = addPausesToText(question.lecture_script);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/deepgram/aura-1`;

    const ttsResponse = await axios.post(
      endpoint,
      { text: textWithPauses },
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    const audioBuffer = Buffer.from(ttsResponse.data);
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Cloudflare TTS 生成了空的音频 Buffer。");
    }

    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: "video", folder: "toefl_lectures" },
        (error, result) => {
          if (error) return reject(error);
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
      `✅ [后台任务 CF-Aura-TTS] 题目 #${questionId} 的音频已生成并保存: ${audioUrl}`
    );
  } catch (error) {
    const errorDetails = error.response
      ? JSON.parse(Buffer.from(error.response.data).toString())
      : error.message;
    console.error(
      `❌ [后台任务 CF-Aura-TTS] 为题目 #${questionId} 生成音频时出错:`,
      errorDetails
    );
  }
}

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

// --- API 路由 (submit-response 路由有微小改动) ---
app.post("/api/generate-audio/:id", authenticateToken, async (req, res) => {
  // ... (保持不变)
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

app.get("/api/writing-test", async (req, res) => {
  // ... (保持不变)
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

app.get("/api/questions", async (req, res) => {
  // ... (保持不变)
  try {
    const sql = `SELECT id, title, topic, task_type FROM questions ORDER BY id`;
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error("获取题目列表失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

app.get("/api/questions/:id", async (req, res) => {
  // ... (保持不变)
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

app.post("/api/auth/register", async (req, res) => {
  // ... (保持不变)
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

app.post("/api/auth/login", async (req, res) => {
  // ... (保持不变)
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

        // === 将 task_type 传递给AI评分函数 ===
        const aiResult = await callAIScoringAPI(
          content || "",
          promptText,
          task_type
        );

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

app.get("/api/history", authenticateToken, async (req, res) => {
  // ... (保持不变)
  const userId = req.user.id;
  try {
    const sql = `SELECT r.id, r.word_count, r.submitted_at, COALESCE(q.title, 'Archived Question') as question_title FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.user_id = $1 ORDER BY r.submitted_at DESC;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("获取写作历史失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

app.get("/api/history/:id", authenticateToken, async (req, res) => {
  // ... (保持不变)
  const { id } = req.params;
  const userId = req.user.id;
  const sql = `SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, r.ai_score, r.ai_feedback, q.* FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.id = $1 AND r.user_id = $2;`;
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
