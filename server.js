// --- START OF FILE server.js (Absolutely Complete Final Version with Enhanced Logging) ---

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
const util = require("util");
const englishWords = require("an-array-of-english-words");

// --- 配置 Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// --- 辅助函数 ---

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

async function callAIPolishAPI(responseText) {
  console.log("🤖 AI polishing started...");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
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

async function callAIScoringAPI(responseText, promptText, taskType) {
  console.log(
    `🤖 AI scoring started (Task: ${taskType}) with mistake extraction...`
  );
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert ETS-trained evaluator for the TOEFL iBT Writing section. Your task is twofold:
1.  **Provide Holistic Feedback**: Evaluate the user's response based on official rubrics and provide a score and structured feedback.
2.  **Extract Specific Mistakes**: Identify and list individual grammar, spelling, punctuation, and vocabulary errors.

Follow these steps precisely:
1.  In a <thinking> block, analyze the user's response against the relevant rubric (Integrated or Academic Discussion).
2.  After your analysis, provide your final answer ONLY as a single, valid JSON object. Do not include any text before or after the JSON block.

**JSON Output Format:**
{
  "overallScore": <integer from 0 to 30>,
  "feedback": {
    "taskResponse": { "rating": "<string>", "comment": "<string>" },
    "organization": { "rating": "<string>", "comment": "<string>" },
    "languageUse": { "rating": "<string>", "comment": "<string>" },
    "generalSuggestion": "<string>"
  },
  "mistakes": [
    {
      "type": "<'grammar'|'spelling'|'punctuation'|'vocabulary'|'style'>",
      "original": "<The exact incorrect phrase from user's text>",
      "corrected": "<The suggested correct phrase>",
      "explanation": "<A brief, clear explanation of the error>"
    }
  ]
}`;
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
    const aiResultContent = response.data.choices[0].message.content;
    const jsonMatch = aiResultContent.match(/{[\s\S]*}/);
    if (!jsonMatch) throw new Error("AI did not return a valid JSON object.");
    const result = JSON.parse(jsonMatch[0]);
    return {
      score: result.overallScore,
      feedback: JSON.stringify(result.feedback),
      mistakes: result.mistakes || [],
    };
  } catch (error) {
    console.error(
      "AI Scoring API Error:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to get a response from the AI service.");
  }
}

async function callAIAnalysisAPI(feedbacks) {
  console.log("🤖 AI common mistakes analysis started...");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
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

function processTextForTTS(text) {
  if (!text) return "";
  return text;
}

async function generateAudioIfNeeded(questionId) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.log(
      "🔊 [Cloudflare TTS] Audio generation skipped: Environment variables not configured."
    );
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
      `🎤 [Backend Task CF-Aura-TTS] Starting audio generation for question #${questionId}...`
    );
    const textForTTS = processTextForTTS(question.lecture_script);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/deepgram/aura-1`;
    const ttsResponse = await axios.post(
      endpoint,
      { text: textForTTS },
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
      throw new Error("Cloudflare TTS generated an empty audio buffer.");
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
      `✅ [Backend Task CF-Aura-TTS] Audio for question #${questionId} has been generated and saved: ${audioUrl}`
    );
  } catch (error) {
    let errorDetails = error.message;
    if (error.response && error.response.data) {
      try {
        errorDetails = JSON.parse(Buffer.from(error.response.data).toString());
      } catch (e) {
        errorDetails = "Could not parse error response from Cloudflare.";
      }
    }
    console.error(
      `❌ [Backend Task CF-Aura-TTS] Error during audio generation for question #${questionId}:`,
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
  if (err) return console.error("❌ Database connection failed:", err);
  console.log("✅ Successfully connected to PostgreSQL database!");
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

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  }
  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ message: "Username already exists." });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const sql = `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`;
    const newUser = await pool.query(sql, [username, hashedPassword]);
    res
      .status(201)
      .json({ message: "Registration successful!", user: newUser.rows[0] });
  } catch (err) {
    console.error("Registration failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid username or password." });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid username or password." });
    }
    const payload = { id: user.id, username: user.username };
    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || "your_default_secret_key",
      { expiresIn: "1d" }
    );
    res.json({
      message: "Login successful!",
      token,
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/questions", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT q.id, q.title, q.topic, q.task_type, CASE WHEN r.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_completed FROM questions q LEFT JOIN (SELECT DISTINCT question_id, user_id FROM responses WHERE user_id = $1) r ON q.id = r.question_id ORDER BY q.id;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get question list:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/questions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    generateAudioIfNeeded(id);
    const sql = `SELECT * FROM questions WHERE id = $1`;
    const result = await pool.query(sql, [id]);
    if (result.rows.length === 0)
      return res.status(404).json({ message: "Question not found." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`Failed to get question detail ID ${id}:`, err);
    res.status(500).json({ message: "Internal server error." });
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
    console.error("Failed to get writing test questions:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/submit-response", authenticateToken, async (req, res) => {
  const { content, wordCount, questionId, task_type } = req.body;
  const userId = req.user.id;
  const qId = parseInt(questionId, 10);
  if ((!content && wordCount > 0) || !wordCount || isNaN(qId) || !task_type) {
    return res.status(400).json({
      message: "Request is missing required information or is malformed.",
    });
  }

  try {
    const responseSql = `INSERT INTO responses (content, word_count, question_id, task_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const responseResult = await pool.query(responseSql, [
      content || "",
      wordCount,
      qId,
      task_type,
      userId,
    ]);
    const newResponseId = responseResult.rows[0].id;

    res
      .status(201)
      .json({ message: "Submission successful!", id: newResponseId });

    (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const questionRes = await client.query(
          "SELECT * FROM questions WHERE id = $1",
          [qId]
        );
        if (questionRes.rows.length === 0)
          throw new Error(`Question with ID ${qId} not found.`);
        const questionData = questionRes.rows[0];

        let promptText =
          task_type === "integrated_writing"
            ? `Reading: ${questionData.reading_passage}\nLecture: ${questionData.lecture_script}`
            : `Professor's Prompt: ${questionData.professor_prompt}\n${questionData.student1_author}'s Post: ${questionData.student1_post}\n${questionData.student2_author}'s Post: ${questionData.student2_post}`;

        const aiResult = await callAIScoringAPI(
          content || "",
          promptText,
          task_type
        );

        await client.query(
          `UPDATE responses SET ai_score = $1, ai_feedback = $2 WHERE id = $3`,
          [aiResult.score, aiResult.feedback, newResponseId]
        );

        if (aiResult.mistakes && aiResult.mistakes.length > 0) {
          const mistakeInsertPromises = aiResult.mistakes.map((mistake) => {
            const mistakeSql = `INSERT INTO mistakes (user_id, response_id, type, original_text, corrected_text, explanation) VALUES ($1, $2, $3, $4, $5, $6)`;
            const validTypes = [
              "grammar",
              "spelling",
              "style",
              "vocabulary",
              "punctuation",
            ];
            const mistakeType = validTypes.includes(
              String(mistake.type).toLowerCase()
            )
              ? String(mistake.type).toLowerCase()
              : "style";

            return client.query(mistakeSql, [
              userId,
              newResponseId,
              mistakeType,
              mistake.original,
              mistake.corrected,
              mistake.explanation,
            ]);
          });
          await Promise.all(mistakeInsertPromises);
          console.log(
            `✅ Saved ${aiResult.mistakes.length} mistakes for response #${newResponseId}`
          );
        }

        await client.query("COMMIT");

        await checkAndAwardAchievements(userId, newResponseId);
      } catch (aiError) {
        await client.query("ROLLBACK");
        console.error(
          `❌ AI background task failed (Response ID: ${newResponseId}):`,
          aiError
        );
      } finally {
        client.release();
      }
    })();
  } catch (err) {
    console.error("Database insertion failed:", err);
  }
});

app.get("/api/history", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT r.id, r.word_count, r.submitted_at, COALESCE(q.title, 'Archived Question') as question_title FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.user_id = $1 ORDER BY r.submitted_at DESC;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get writing history:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/history/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const sql = `SELECT r.id, r.question_id, r.content as user_response, r.word_count, r.submitted_at, r.ai_score, r.ai_feedback, r.is_for_review, q.* FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.id = $1 AND r.user_id = $2;`;
  try {
    const result = await pool.query(sql, [id, userId]);
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ message: "History record not found or permission denied." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`Failed to get history detail ID ${id}:`, err);
    res.status(500).json({ message: "Internal server error." });
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
      console.error(
        `Failed to toggle review status (Response ID: ${id}):`,
        err
      );
      res.status(500).json({ message: "Internal server error." });
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
    console.error(`AI polish failed (Response ID: ${id}):`, err);
    res.status(500).json({ message: "Failed to get AI polish suggestion." });
  }
});

app.get("/api/review-list", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT r.id, r.word_count, r.submitted_at, COALESCE(q.title, 'Archived Question') as question_title FROM responses r LEFT JOIN questions q ON r.question_id = q.id WHERE r.user_id = $1 AND r.is_for_review = TRUE ORDER BY r.submitted_at DESC;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get review list:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/mistakes", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `
      SELECT m.id, m.type, m.original_text, m.corrected_text, m.explanation, m.created_at, m.response_id, q.title as question_title
      FROM mistakes m
      JOIN responses r ON m.response_id = r.id
      JOIN questions q ON r.question_id = q.id
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC;
    `;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get mistakes:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/user/stats", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `
      WITH ValidResponses AS (
        SELECT * FROM responses 
        WHERE user_id = $1 AND ai_score IS NOT NULL AND ai_feedback IS NOT NULL AND ai_feedback LIKE '{%}'
      ), 
      RatingMapping AS (
        SELECT *, 
          DATE(submitted_at) AS submission_date,
          CASE (ai_feedback::jsonb -> 'taskResponse' ->> 'rating')
            WHEN 'Excellent' THEN 4 WHEN 'Good' THEN 3 WHEN 'Fair' THEN 2 WHEN 'Needs Improvement' THEN 1
            ELSE 0
          END AS task_response_score,
          CASE (ai_feedback::jsonb -> 'organization' ->> 'rating')
            WHEN 'Excellent' THEN 4 WHEN 'Good' THEN 3 WHEN 'Fair' THEN 2 WHEN 'Needs Improvement' THEN 1
            ELSE 0
          END AS organization_score,
          CASE (ai_feedback::jsonb -> 'languageUse' ->> 'rating')
            WHEN 'Excellent' THEN 4 WHEN 'Good' THEN 3 WHEN 'Fair' THEN 2 WHEN 'Needs Improvement' THEN 1
            ELSE 0
          END AS language_use_score
        FROM ValidResponses
      )
      SELECT 
        (SELECT json_build_object('total', COUNT(*), 'average', ROUND(AVG(ai_score), 1)) FROM ValidResponses) AS "overallStats",
        (SELECT json_agg(stats) FROM (SELECT task_type, COUNT(*) AS count, ROUND(AVG(ai_score), 1) AS average FROM ValidResponses GROUP BY task_type) AS stats) AS "byType",
        (SELECT json_agg(trends) FROM (SELECT submission_date, ROUND(AVG(ai_score), 1) AS average_score FROM RatingMapping WHERE submitted_at >= NOW() - INTERVAL '30 days' GROUP BY submission_date ORDER BY submission_date) AS trends) AS "scoreTrend",
        (SELECT json_build_object('taskResponse', ROUND(AVG(task_response_score), 2), 'organization', ROUND(AVG(organization_score), 2), 'languageUse', ROUND(AVG(language_use_score), 2)) FROM RatingMapping WHERE task_response_score > 0) AS "feedbackBreakdown";
    `;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to get user stats data:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/user/achievements", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = `SELECT a.id, a.tag, a.name, a.description, a.icon_url, CASE WHEN ua.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS unlocked, ua.unlocked_at FROM achievements a LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1 ORDER BY a.id;`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get user achievements:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/user/writing-analysis", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const responsesQuery = await pool.query(
      "SELECT content, ai_feedback FROM responses WHERE user_id = $1 AND content IS NOT NULL AND content != '' AND ai_feedback IS NOT NULL AND ai_feedback LIKE '{%}'",
      [userId]
    );

    if (responsesQuery.rows.length < 3) {
      return res.status(404).json({
        message:
          "Not enough practice data for a meaningful analysis. Please complete at least 3 practices.",
      });
    }

    const wordSet = new Set(englishWords);
    const checkWord = (word) => wordSet.has(word);

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
      const words = row.content.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      words.forEach((word) => {
        if (!stopWords.has(word) && checkWord(word)) {
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      });
    });
    const wordCloudData = Object.entries(wordCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 50)
      .map(([text, value]) => ({ text, value }));

    const feedbacks = responsesQuery.rows.map((row) =>
      JSON.parse(row.ai_feedback)
    );
    const aiAnalysis = await callAIAnalysisAPI(feedbacks);

    // 【关键修改 2/2】: 在发送前添加详细日志
    const responseData = {
      wordCloud: wordCloudData,
      commonMistakes: aiAnalysis.analysis,
    };
    console.log(
      `✅ [Analysis API] Success for user #${userId}. Sending data summary: { wordCloudLength: ${responseData.wordCloud.length}, commonMistakesLength: ${responseData.commonMistakes.length} }`
    );

    res.json(responseData);
  } catch (err) {
    console.error("❌ Failed to get writing analysis data:", err);
    res.status(500).json({ message: "Internal server error." });
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
  console.log(`🚀 Server is running on port ${PORT}`);
});
