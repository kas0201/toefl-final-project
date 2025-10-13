// --- START OF FILE server.js (Truly, Absolutely, 100% Complete Final Version with Fixes) ---

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");

// --- 配置 Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// --- 检查并授予成就的函数 ---
async function checkAndAwardAchievements(userId, responseId) {
  console.log(`🏆 [Achievement] Checking for user #${userId}...`);
  try {
    const userStatsQuery = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM responses WHERE user_id = $1) as total_practices,
        (SELECT COUNT(*) FROM responses WHERE user_id = $1 AND task_type = 'integrated_writing') as integrated_practices,
        (SELECT COUNT(*) FROM responses WHERE user_id = $1 AND task_type = 'academic_discussion') as academic_practices,
        (SELECT ai_score FROM responses WHERE id = $2) as current_score;
      `,
      [userId, responseId]
    );
    const stats = userStatsQuery.rows[0];
    const achievementsToAward = [];
    if (stats.total_practices >= 1) achievementsToAward.push("FIRST_PRACTICE");
    if (stats.total_practices >= 10) achievementsToAward.push("TEN_PRACTICES");
    if (stats.current_score >= 25) achievementsToAward.push("HIGH_SCORER_25");
    if (stats.integrated_practices >= 5)
      achievementsToAward.push("INTEGRATED_MASTER");
    if (stats.academic_practices >= 5)
      achievementsToAward.push("ACADEMIC_EXPERT");
    if (achievementsToAward.length > 0) {
      const achievementsQuery = await pool.query(
        `SELECT id, tag FROM achievements WHERE tag = ANY($1::varchar[])`,
        [achievementsToAward]
      );
      const achievementIds = achievementsQuery.rows.map((a) => a.id);
      const insertPromises = achievementIds.map((achId) =>
        pool.query(
          `INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2) ON CONFLICT (user_id, achievement_id) DO NOTHING`,
          [userId, achId]
        )
      );
      await Promise.all(insertPromises);
      console.log(
        `✅ [Achievement] User #${userId} was awarded: ${achievementsToAward.join(
          ", "
        )}`
      );
    }
  } catch (error) {
    console.error(
      `❌ [Achievement] Error checking achievements for user #${userId}:`,
      error
    );
  }
}

// --- AI 文本润色函数 ---
async function callAIPolishAPI(responseText) {
  console.log("🤖 AI a commencé le polissage avec un prompt amélioré...");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("AI service is not configured.");
  }
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert academic English editor specializing in refining TOEFL essays. Your task is to revise the user's text to elevate its linguistic quality to that of a high-scoring response (28-30), following these strict principles:\n\n1.  **Preserve Meaning Above All:** This is the most important rule. Strictly preserve the author's original meaning, arguments, and ideas. Do NOT add new information, change their core message, or alter their logical flow.\n\n2.  **Prioritize Natural Language:** Improve vocabulary, sentence structure, and grammar, but always prioritize natural, idiomatic phrasing that a native speaker would use. Avoid replacing words with more 'advanced' synonyms if it creates an awkward, "thesaurus-like" sentence. The goal is fluency and clarity, not just complexity.\n\n3.  **Ensure Accuracy:** Before providing the final output, double-check your revision to ensure you have not introduced any new grammatical, spelling, or logical errors.\n\nYour final output must be ONLY the fully revised text. Do not include any commentary, headings, or explanations before or after the text.`;
  try {
    const response = await axios.post(
      endpoint,
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: responseText },
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
    return { polishedText: response.data.choices[0].message.content };
  } catch (error) {
    throw new Error("Failed to get a response from the AI polishing service.");
  }
}

// --- AI 评分函数 ---
async function callAIScoringAPI(responseText, promptText, taskType) {
  console.log(
    `🤖 AI a commencé à noter (Mode: ${taskType}) avec le mode de pensée deepseek-reasoner...`
  );
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("AI service is not configured.");
  }
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert ETS-trained evaluator for the TOEFL iBT Writing section. Your evaluation must strictly adhere to the official scoring rubrics. Your process is as follows: 1. **Identify Task Type**: First, identify the task type from the user prompt ('Integrated Writing' or 'Academic Discussion'). 2. **Apply Correct Rubric**: In a <thinking> block, analyze the user's response strictly according to the specific rubric for that task type provided below. 3. **Holistic Scoring**: Based on your rubric-based analysis, determine a holistic overall score from 0-30. 4. **Structured Feedback**: Generate concise, constructive feedback for each category within the official rubric. 5. **Final JSON Output**: After the <thinking> block, provide your final answer ONLY as a single, valid JSON object in the specified format. ### Integrated Writing Task Rubric ### If the task is 'Integrated Writing', use these criteria: - **Task Response (Selection & Connection)**: How accurately and completely does the response select the important information from the lecture and explain how it challenges or supports the points in the reading passage? A high-scoring response must clearly connect lecture points to reading points. - **Organization & Development**: Is the response well-organized with a clear structure (e.g., introduction, body paragraphs for each point)? Are the ideas logically connected? - **Language Use**: How effectively is language used? Consider grammar, vocabulary, and sentence structure. Minor errors are acceptable if the meaning is clear. ### Academic Discussion Task Rubric ### If the task is 'Academic Discussion', use these criteria: - **Task Response (Contribution)**: Does the response make a relevant and clear contribution to the discussion? Does it directly address the professor's question and engage with the other students' ideas? - **Organization & Development**: Is the main idea clearly stated? Is it well-supported with reasons, details, and/or examples? Is the response easy to follow? - **Language Use**: Is the language clear and idiomatic? Does it demonstrate a good range of vocabulary and sentence structures? --- **JSON Output Format:** { "overallScore": <integer from 0 to 30>, "feedback": { "taskResponse": { "rating": "<string>", "comment": "<string>" }, "organization": { "rating": "<string>", "comment": "<string>" }, "languageUse": { "rating": "<string>", "comment": "<string>" }, "generalSuggestion": "<string>" } }`;
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
    const result = JSON.parse(jsonMatch[0]);
    return {
      score: result.overallScore,
      feedback: JSON.stringify(result.feedback),
    };
  } catch (error) {
    throw new Error("Failed to get a response from the AI service.");
  }
}

// --- 【新增】AI 总结常犯错误的函数 ---
async function callAIAnalysisAPI(feedbacks) {
  console.log("🤖 AI a commencé l'analyse des erreurs communes...");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("AI service is not configured.");
  }
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert writing coach. Based on the provided list of feedback JSON objects from a user's past TOEFL essays, identify and summarize the top 3-5 recurring weaknesses or common mistakes. For each point, provide a concise description of the issue and a concrete suggestion for improvement. Present your analysis in a clear, easy-to-read markdown format. Focus on patterns in 'Language Use', 'Organization & Development', and 'Task Response'.`;
  const feedbackText = feedbacks.map((f) => JSON.stringify(f)).join("\n---\n");
  try {
    const response = await axios.post(
      endpoint,
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: feedbackText },
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
    return { analysis: response.data.choices[0].message.content };
  } catch (error) {
    console.error(
      "AI Analysis API Error:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to get a response from the AI analysis service.");
  }
}

// --- 音频生成函数 ---
function addPausesToText(text) {
  if (!text) return "";
  let processedText = text;
  processedText = processedText.replace(/\./g, ". ... ");
  processedText = processedText.replace(/\n/g, ". ... ... \n");
  return processedText;
}
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

// --- API 路由 ---
app.get("/api/questions", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT q.id, q.title, q.topic, q.task_type, CASE WHEN r.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_completed FROM questions q LEFT JOIN (SELECT DISTINCT question_id, user_id FROM responses WHERE user_id = $1) r ON q.id = r.question_id ORDER BY q.id;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("获取题目列表失败:", err);
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
        if (questionRes.rows.length === 0) {
          throw new Error(`Question with ID ${qId} not found.`);
        }
        const questionData = questionRes.rows[0];
        let promptText = "";
        if (questionData.task_type === "integrated_writing") {
          promptText = `Reading: ${questionData.reading_passage}\nLecture: ${questionData.lecture_script}`;
        } else {
          promptText = `Professor's Prompt: ${questionData.professor_prompt}\n${questionData.student1_author}'s Post: ${questionData.student1_post}\n${questionData.student2_author}'s Post: ${questionData.student2_post}`;
        }
        const aiResult = await callAIScoringAPI(
          content || "",
          promptText,
          questionData.task_type
        );
        await pool.query(
          `UPDATE responses SET ai_score = $1, ai_feedback = $2 WHERE id = $3`,
          [aiResult.score, aiResult.feedback, newResponseId]
        );
        await checkAndAwardAchievements(userId, newResponseId);
      } catch (aiError) {
        console.error(
          `❌ AI 后台任务失败 (Response ID: ${newResponseId}):`,
          aiError
        );
      }
    })();
  } catch (err) {
    console.error("数据库插入失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

app.get("/api/review-list", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT r.id, r.word_count, r.submitted_at, COALESCE(q.title, 'Archived Question') as question_title FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.user_id = $1 AND r.is_for_review = TRUE ORDER BY r.submitted_at DESC;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("获取复习列表失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

app.post(
  "/api/responses/:id/toggle-review",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    try {
      await pool.query(
        `UPDATE responses SET is_for_review = NOT is_for_review WHERE id = $1 AND user_id = $2;`,
        [id, userId]
      );
      const result = await pool.query(
        `SELECT is_for_review FROM responses WHERE id = $1 AND user_id = $2;`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Response not found or you do not have permission.",
        });
      }
      res.json({ is_for_review: result.rows[0].is_for_review });
    } catch (err) {
      console.error(`切换复习状态失败 (Response ID: ${id}):`, err);
      res.status(500).json({ message: "服务器内部错误。" });
    }
  }
);

app.post("/api/responses/:id/polish", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const responseQuery = await pool.query(
      "SELECT content FROM responses WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (responseQuery.rows.length === 0) {
      return res.status(404).json({ message: "Response not found." });
    }
    const originalText = responseQuery.rows[0].content;
    if (!originalText || originalText.trim().split(/\s+/).length < 20) {
      return res.status(400).json({
        message:
          "Your text is too short for a meaningful revision. Please write at least 20 words.",
      });
    }
    const aiResult = await callAIPolishAPI(originalText);
    res.json({ polishedText: aiResult.polishedText });
  } catch (err) {
    console.error(`AI 润色失败 (Response ID: ${id}):`, err);
    res.status(500).json({ message: "Failed to get AI polish suggestion." });
  }
});

app.get("/api/history/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const sql = `SELECT r.id, r.content as user_response, r.word_count, r.submitted_at, r.ai_score, r.ai_feedback, r.is_for_review, q.* FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.id = $1 AND r.user_id = $2;`;
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

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "用户名和密码不能为空。" });
  }
  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
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

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "用户名和密码不能为空。" });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ message: "用户名或密码错误。" });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "用户名或密码错误。" });
    }
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

app.get("/api/history", authenticateToken, async (req, res) => {
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

app.get("/api/user/achievements", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT a.id, a.tag, a.name, a.description, a.icon_url, CASE WHEN ua.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS unlocked, ua.unlocked_at FROM achievements a LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1 ORDER BY a.id;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("获取用户成就失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

// --- 【关键修复】: 新增写作分析API路由 ---
app.get("/api/user/writing-analysis", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // 1. 获取用户所有有效的练习记录
    const responsesQuery = await pool.query(
      "SELECT content, ai_feedback FROM responses WHERE user_id = $1 AND content IS NOT NULL AND content != '' AND ai_feedback IS NOT NULL AND ai_feedback LIKE '{%}'",
      [userId]
    );

    // 2. 检查是否有足够的的数据进行分析
    if (responsesQuery.rows.length < 3) {
      return res.status(404).json({
        message:
          "Not enough practice data for a meaningful analysis. Please complete at least 3 practices.",
      });
    }

    // 3. 计算高频词云
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "and",
      "but",
      "or",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "is",
      "are",
      "was",
      "were",
      "it",
      "i",
      "you",
      "he",
      "she",
      "they",
      "we",
      "that",
      "this",
      "with",
      "as",
      "not",
      "be",
      "has",
      "have",
      "do",
      "does",
      "did",
      "from",
      "by",
      "about",
      "can",
      "will",
    ]);
    const wordCounts = {};
    responsesQuery.rows.forEach((row) => {
      const words = row.content.toLowerCase().match(/\b\w+\b/g) || [];
      words.forEach((word) => {
        if (!stopWords.has(word) && isNaN(word)) {
          // 排除停用词和纯数字
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      });
    });
    const wordCloudData = Object.entries(wordCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 50) // 取前50个高频词
      .map(([text, value]) => ({ text, value }));

    // 4. 调用AI分析常见错误
    const feedbacks = responsesQuery.rows.map((row) =>
      JSON.parse(row.ai_feedback)
    );
    const aiAnalysis = await callAIAnalysisAPI(feedbacks);

    // 5. 返回结果
    res.json({ wordCloud: wordCloudData, commonMistakes: aiAnalysis.analysis });
  } catch (err) {
    console.error("获取写作分析数据失败:", err);
    res.status(500).json({ message: "服务器内部错误。" });
  }
});

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

// --- 启动服务器 ---
app.use(express.static("public"));
app.listen(PORT, () => {
  console.log(`🚀 服务器正在端口 ${PORT} 上运行`);
});
