// --- START OF FILE server.js (UPDATED with Strict Scoring and Forensic Error Analysis - FULLY UNABRIDGED) ---
// 测试环境变量请参考 README.md 中的说明。

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
const crypto = require("crypto");
const englishWords = require("an-array-of-english-words");
const { version: appVersion } = require("./package.json");

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "1h";
const REFRESH_TOKEN_DAYS = parseInt(
  process.env.REFRESH_TOKEN_EXPIRY_DAYS || "7",
  10
);
const REFRESH_COOKIE_NAME = "refreshToken";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

async function generateAudioInBackground(questionId) {
  console.log(
    `?? [BACKGROUND JOB - CF] Starting audio generation for question #${questionId}...`
  );

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;

      if (!accountId || !apiToken) {
        console.error(
          "? [BACKGROUND JOB - CF] Cloudflare credentials are not set."
        );
        return;
      }

      const poolClient = await pool.connect();
      try {
        const questionQuery = await poolClient.query(
          "SELECT lecture_script, lecture_audio_url FROM questions WHERE id = $1",
          [questionId]
        );
        const question = questionQuery.rows[0];

        if (!question || question.lecture_audio_url) {
          console.log(
            `[BACKGROUND JOB - CF] Skipped: Question #${questionId} not found or already has audio.`
          );
          return;
        }

        const textForTTS = (question.lecture_script || "")
          .replace(/[\s\n\r]+/g, " ")
          .trim();
        if (!textForTTS) {
          console.log(
            `[BACKGROUND JOB - CF] Skipped: Question #${questionId} has no script.`
          );
          return;
        }

        const model = "@cf/deepgram/aura-1";
        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
        const requestBody = { text: textForTTS };

        console.log(
          `[BACKGROUND JOB - CF] Attempt ${attempt}: Sending POST request to Cloudflare AI with model ${model}...`
        );

        const response = await axios.post(apiUrl, requestBody, {
          headers: { Authorization: `Bearer ${apiToken}` },
          responseType: "arraybuffer",
        });

        const audioBuffer = response.data;

        if (!audioBuffer || audioBuffer.length === 0) {
          throw new Error("Cloudflare AI returned an empty audio buffer.");
        }

        console.log(
          `[BACKGROUND JOB - CF] Received audio buffer from Cloudflare.`
        );

        const uploadPromise = new Promise((resolve, reject) => {
          cloudinary.uploader
            .upload_stream(
              { resource_type: "video", folder: "toefl_lectures" },
              (error, uploadResult) =>
                error ? reject(error) : resolve(uploadResult)
            )
            .end(audioBuffer);
        });
        const uploadResult = await uploadPromise;

        const finalAudioUrl = uploadResult.secure_url;
        await poolClient.query(
          "UPDATE questions SET lecture_audio_url = $1 WHERE id = $2",
          [finalAudioUrl, questionId]
        );
        console.log(
          `? [BACKGROUND JOB - CF] Success on attempt ${attempt}! Audio for question #${questionId} is ready: ${finalAudioUrl}`
        );

        return;
      } finally {
        poolClient.release();
      }
    } catch (error) {
      const errorMessage = error.response
        ? `Status ${error.response.status}: ${Buffer.from(
            error.response.data
          ).toString()}`
        : error.message;

      console.error(
        `? [BACKGROUND JOB - CF] FAILED on attempt ${attempt} for question #${questionId}:`,
        errorMessage
      );

      if (attempt < MAX_RETRIES) {
        console.log(
          `[BACKGROUND JOB - CF] Waiting ${
            RETRY_DELAY / 1000
          } seconds before retrying...`
        );
        await new Promise((res) => setTimeout(res, RETRY_DELAY));
      } else {
        console.error(
          `? [BACKGROUND JOB - CF] All ${MAX_RETRIES} attempts failed for question #${questionId}. Giving up.`
        );
      }
    }
  }
}

async function checkAndAwardAchievements(userId, responseId) {
  console.log(
    `?? [ACHIEVEMENT] Checking for user #${userId} regarding response #${responseId}...`
  );
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
        `? [ACHIEVEMENT] User #${userId} was awarded: ${achievementsToAward.join(
          ", "
        )}`
      );
    } else {
      console.log(`?? [ACHIEVEMENT] No new achievements for user #${userId}.`);
    }
  } catch (error) {
    console.error(
      `? [ACHIEVEMENT] Error checking achievements for user #${userId}:`,
      error
    );
  }
}

const hashTokenValue = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

function generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role || "student",
    },
    process.env.JWT_SECRET || "your_default_secret_key",
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function setRefreshCookie(res, token) {
  const maxAge = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge,
    path: "/",
  });
}

async function persistRefreshToken(userId, token) {
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hashTokenValue(token), expiresAt]
  );
}

async function revokeRefreshToken(token) {
  if (!token) return;
  await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashTokenValue(token)]
  );
}

async function verifyRefreshToken(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT user_id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashTokenValue(token)]
  );
  return result.rows[0]?.user_id || null;
}

async function issueSessionTokens(user, res) {
  const accessToken = generateAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString("hex");
  await persistRefreshToken(user.id, refreshToken);
  setRefreshCookie(res, refreshToken);
  return { accessToken, refreshToken };
}

async function revokeAllRefreshTokensForUser(userId) {
  await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

async function sendPasswordResetEmail(email, token) {
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  const resetLink = `${baseUrl}/reset-password.html?token=${token}`;
  console.log(
    `?? [RESET] Password reset link for ${email}: ${resetLink} (share via email/SMS gateway).`
  );
}

const parseTagArray = (tags) => {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  return String(tags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
};

const MISTAKE_STATUSES = ["new", "reviewing", "mastered"];

const cookieParserMiddleware = (req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers["cookie"];
  if (!cookieHeader) return next();
  cookieHeader.split(";").forEach((pair) => {
    const [name, ...rest] = pair.split("=");
    if (!name) return;
    const value = rest.join("=").trim();
    req.cookies[name.trim()] = decodeURIComponent(value || "");
  });
  next();
};
async function callAIPolishAPI(responseText) {
  console.log("?? [AI] Polishing started with CONSERVATIVE prompt...");
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
  const endpoint = "https://api.deepseek.com/chat/completions";
  const systemPrompt = `You are an expert academic English proofreader, not a rewriter. Your task is to polish the user's TOEFL essay by making only the most necessary corrections and refinements, following these four strict rules:

1.  **Rule #1: Preserve Original Meaning and Voice.** This is the most critical rule. Do NOT alter the user's arguments, ideas, or overall tone. The final text must be recognizably the user's own work.

2.  **Rule #2: Minimal Intervention.** Only correct clear errors in grammar, spelling, and punctuation. You may improve awkward phrasing or imprecise vocabulary. **If a sentence is already grammatically correct and its meaning is clear, LEAVE IT UNCHANGED.** Do not rewrite entire sentences simply for stylistic preference.

3.  **Rule #3: Focus on Clarity and Fluency.** Your changes should make the text more natural and easier to read, not just more complex. Avoid using obscure words when a simpler one is more effective.

4.  **Rule #4: Final Output Format.** Your output must be ONLY the fully revised text. Do not include any explanations, headings, or comments before or after the text.`;

  try {
    const response = await axios.post(
      endpoint,
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: responseText },
        ],
        temperature: 0.3,
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
    `?? [AI] Strict scoring and forensic analysis started (Task: ${taskType})...`
  );
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
  const endpoint = "https://api.deepseek.com/chat/completions";

  const systemPrompt = `You are a strict, official ETS rater for the TOEFL iBT Writing section. Your only goal is to emulate the official scoring rubric with maximum precision and identify every single error.

Your job has two parts.

**PART 1: HOLISTIC SCORING**
Evaluate the user's response against the official TOEFL rubrics for the specified task type ('Integrated Writing' or 'Academic Discussion'). Provide a holistic score from 0-30 and detailed feedback for each dimension. Be critical and justify your ratings with specific examples from the user's text.

**PART 2: FORENSIC MISTAKE ANALYSIS**
This is equally critical. Perform a forensic-level analysis of the text to identify **every single error**, no matter how minor. Your goal is to be exhaustive.
- For each error, you must categorize it using the provided "type" and "sub_type" lists.
- Do not group multiple errors. Each distinct issue should be its own object in the 'mistakes' array.
- The 'mistakes' array must be a comprehensive list of all identifiable issues. Be meticulous.

**FINAL OUTPUT INSTRUCTIONS:**
Before generating the JSON, you MUST use a <thinking> block to outline your step-by-step evaluation process, including your reasoning for the score and the list of errors you've found. After the <thinking> block, your final output **MUST BE ONLY** a single, valid JSON object and nothing else.

**JSON OUTPUT FORMAT & MISTAKE CATEGORIES:**
{
  "overallScore": <integer from 0 to 30>,
  "feedback": {
    "taskResponse": { "rating": "<'Excellent'|'Good'|'Fair'|'Needs Improvement'>", "comment": "<string>" },
    "organization": { "rating": "<'Excellent'|'Good'|'Fair'|'Needs Improvement'>", "comment": "<string>" },
    "languageUse": { "rating": "<'Excellent'|'Good'|'Fair'|'Needs Improvement'>", "comment": "<string>" },
    "generalSuggestion": "<string>"
  },
  "mistakes": [
    {
      "type": "<'grammar'|'spelling'|'punctuation'|'vocabulary'|'style'>",
      "sub_type": "<CHOOSE ONE from the list below>",
      "original": "<The exact incorrect phrase from user's text>",
      "corrected": "<The suggested correct phrase>",
      "explanation": "<A brief, clear explanation of why it was wrong>"
    }
  ]
}

**MISTAKE SUB-TYPE LIST (Choose ONE for each mistake):**
- **For 'grammar' type:**
  - 'verb_tense': Incorrect tense usage.
  - 'subject_verb_agreement': Subject and verb do not agree.
  - 'article_usage': Incorrect use of a/an/the or missing article.
  - 'preposition': Incorrect preposition (in, on, at, etc.).
  - 'sentence_structure': e.g., run-on sentence, fragment, incorrect word order.
  - 'pronoun_error': Incorrect pronoun usage or agreement.
  - 'pluralization': Incorrect use of singular/plural nouns.
  - 'grammar_other': Any other grammatical error.
- **For 'vocabulary' type:**
  - 'word_choice': A grammatically correct but unsuitable or less precise word.
  - 'word_form': Using the wrong form of a word (e.g., noun instead of adjective).
  - 'idiom_error': An unnatural or incorrect idiomatic expression.
  - 'vocabulary_other': Any other vocabulary error.
- **For 'style' type:**
  - 'wordiness': The phrase is too long or contains redundant words.
  - 'awkward_phrasing': The sentence is grammatically correct but sounds unnatural.
  - 'repetition': Repetitive use of words or sentence structures.
  - 'tone': The language is too informal or inappropriate for an academic essay.
  - 'style_other': Any other stylistic issue.
- **For 'spelling' and 'punctuation' types:**
  - Use 'spelling' or 'punctuation' as the sub_type respectively.
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
        temperature: 0.3,
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
  console.log("?? [AI] Common mistakes analysis started...");
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

async function callAIGenerateEssayAPI(promptText, taskType) {
  console.log(`?? [AI] Model Essay generation started (Task: ${taskType})...`);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("AI service is not configured.");
  const endpoint = "https://api.deepseek.com/chat/completions";

  const taskTypeName =
    taskType === "integrated_writing"
      ? "Integrated Writing"
      : "Academic Discussion";

  const systemPrompt = `You are an expert TOEFL test-taker aiming for a perfect score of 30. Your task is to write a high-scoring, well-structured, and coherent essay based on the provided prompt. 
- For an '${taskTypeName}' task, ensure your response directly addresses the prompt, uses sophisticated vocabulary and complex sentence structures, and is logically organized.
- Adhere to typical word count guidelines (around 225-300 for Integrated, 100+ for Academic Discussion).
- Your output must be ONLY the essay text. Do not include any headings, explanations, or comments.`;

  const userPrompt = `## TASK TYPE ##\n${taskTypeName}\n\n## PROMPT ##\n${promptText}\n\n## YOUR ESSAY ##`;

  try {
    const response = await axios.post(
      endpoint,
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    return { essayText: response.data.choices[0].message.content };
  } catch (error) {
    console.error(
      "AI Model Essay API Error:",
      error.response ? error.response.data : error.message
    );
    throw new Error(
      "Failed to get a response from the AI essay generation service."
    );
  }
}

async function processResponseWithAI(responseId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const responseQuery = await client.query(
      `SELECT r.id, r.content, r.task_type, r.user_id, r.question_id,
              q.reading_passage, q.lecture_script, q.professor_prompt,
              q.student1_author, q.student1_post, q.student2_author, q.student2_post
       FROM responses r
       JOIN questions q ON r.question_id = q.id
       WHERE r.id = $1
       FOR UPDATE`,
      [responseId]
    );
    if (!responseQuery.rows.length) {
      throw new Error(`Response ${responseId} not found for scoring.`);
    }
    const responseRow = responseQuery.rows[0];
    let promptText =
      responseRow.task_type === "integrated_writing"
        ? `Reading: ${responseRow.reading_passage}\nLecture: ${responseRow.lecture_script}`
        : `Professor's Prompt: ${responseRow.professor_prompt}\n${responseRow.student1_author}'s Post: ${responseRow.student1_post}\n${responseRow.student2_author}'s Post: ${responseRow.student2_post}`;
    const aiResult = await callAIScoringAPI(
      responseRow.content || "",
      promptText,
      responseRow.task_type
    );
    await client.query(
      `UPDATE responses
       SET ai_score = $1,
           ai_feedback = $2,
           processing_status = 'completed',
           processing_error = NULL
       WHERE id = $3`,
      [aiResult.score, aiResult.feedback, responseId]
    );
    await client.query("DELETE FROM mistakes WHERE response_id = $1", [
      responseId,
    ]);
    if (aiResult.mistakes && aiResult.mistakes.length > 0) {
      const validTypes = [
        "grammar",
        "spelling",
        "style",
        "vocabulary",
        "punctuation",
      ];
      for (const mistake of aiResult.mistakes) {
        const mistakeType = validTypes.includes(
          String(mistake.type).toLowerCase()
        )
          ? String(mistake.type).toLowerCase()
          : "style";
        const mistakeSubType = mistake.sub_type || "other";
        await client.query(
          `INSERT INTO mistakes (user_id, response_id, type, sub_type, original_text, corrected_text, explanation)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            responseRow.user_id,
            responseId,
            mistakeType,
            mistakeSubType,
            mistake.original,
            mistake.corrected,
            mistake.explanation,
          ]
        );
      }
      console.log(
        `? [BACKGROUND] Saved ${aiResult.mistakes.length} mistakes for response #${responseId}`
      );
    }
    await client.query("COMMIT");
    await checkAndAwardAchievements(responseRow.user_id, responseId);
    console.log(
      `? [BACKGROUND] Successfully finished all AI processing for response #${responseId}.`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      `? [BACKGROUND] AI background task failed for response #${responseId}:`,
      error
    );
    await pool.query(
      `UPDATE responses
       SET processing_status = 'failed',
           processing_error = $2
       WHERE id = $1`,
      [responseId, error.message]
    );
  } finally {
    client.release();
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParserMiddleware);

const createRateLimiter = ({ windowMs, max, message }) => {
  const store = new Map();
  return (req, res, next) => {
    const key = req.ip || req.headers["x-forwarded-for"] || "global";
    const now = Date.now();
    const timestamps = store.get(key) || [];
    const recent = timestamps.filter((ts) => ts > now - windowMs);
    recent.push(now);
    store.set(key, recent);
    if (recent.length > max) {
      const payload =
        typeof message === "string"
          ? { message }
          : message || { message: "Too many requests." };
      return res.status(429).json(payload);
    }
    next();
  };
};

const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many authentication attempts. Please try again later.",
});

const passwordResetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many password reset attempts. Please try again later.",
});

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "? DATABASE_URL is not set. Please configure your database connection string."
  );
  console.error(
    "  - Render: add DATABASE_URL in the Environment tab and redeploy."
  );
  console.error(
    "  - Local dev: set DATABASE_URL in your shell or a .env file before starting the server."
  );
  process.exit(1);
}

const poolConfig = { connectionString };
if (!/sslmode=require/i.test(connectionString)) {
  // Supabase already enforces SSL via sslmode=require; only disable verification when absent.
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);
if (process.env.NODE_ENV !== "test") {
  pool
    .connect()
    .then(async (client) => {
      console.log("? Successfully connected to PostgreSQL database!");
      client.release();
      try {
        await ensureBootstrapSchema();
        console.log("? [BOOTSTRAP] Schema checks completed.");
      } catch (schemaError) {
        console.error("? [BOOTSTRAP] Schema verification failed:", schemaError);
        setTimeout(() => process.exit(1), 1000);
      }
    })
    .catch((err) => {
      console.error("? Database connection failed:", err);
      console.error(
        "Render will restart this service automatically once the database becomes available."
      );
      setTimeout(() => process.exit(1), 1000);
    });
} else {
  console.log("? Skipping PostgreSQL connection verification in test mode.");
}

async function ensureBootstrapSchema() {
  const statements = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'student'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS writing_drafts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      content TEXT DEFAULT '',
      word_count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, question_id)
    )`,
    "ALTER TABLE responses ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'queued'",
    "ALTER TABLE responses ADD COLUMN IF NOT EXISTS processing_error TEXT",
    "ALTER TABLE mistakes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'",
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[]",
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS difficulty TEXT",
  ];

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      console.error("? [BOOTSTRAP] Statement failed:", statement, error);
      throw error;
    }
  }

  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_writing_drafts_user_question ON writing_drafts(user_id, question_id)"
  );
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token =
    (authHeader && authHeader.split(" ")[1]) ||
    req.headers["x-access-token"];
  if (!token) {
    return res.status(401).json({ message: "Authentication required." });
  }
  jwt.verify(
    token,
    process.env.JWT_SECRET || "your_default_secret_key",
    (err, user) => {
      if (err) return res.status(403).json({ message: "Invalid token." });
      req.user = user;
      next();
    }
  );
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
};

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { username, password, email } = req.body;
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!username || !password || !normalizedEmail) {
    return res.status(400).json({
      message: "Username, email, and password are required.",
    });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({ message: "Please supply a valid email." });
  }
  try {
    const userCheck = await pool.query(
      "SELECT 1 FROM users WHERE username = $1 OR email = $2",
      [username, normalizedEmail]
    );
    if (userCheck.rows.length > 0) {
      return res
        .status(409)
        .json({ message: "Username or email already exists." });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, role`;
    const newUser = await pool.query(sql, [
      username,
      normalizedEmail,
      hashedPassword,
    ]);
    const tokenBundle = await issueSessionTokens(newUser.rows[0], res);
    res.status(201).json({
      message: "Registration successful!",
      token: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      user: newUser.rows[0],
    });
  } catch (err) {
    console.error("Registration failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { username, email, identifier: rawIdentifier, password } = req.body;
  const identifier =
    (username || email || rawIdentifier || "").trim().toLowerCase();
  if (!identifier || !password) {
    return res
      .status(400)
      .json({ message: "Username/email and password are required." });
  }
  try {
    const result = await pool.query(
      "SELECT id, username, email, password_hash, role FROM users WHERE LOWER(username) = $1 OR email = $1 LIMIT 1",
      [identifier]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
      user.id,
    ]);
    const tokenBundle = await issueSessionTokens(user, res);
    res.json({
      message: "Login successful!",
      token: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  const incomingToken =
    req.cookies[REFRESH_COOKIE_NAME] || req.body.refreshToken;
  if (!incomingToken) {
    return res.status(400).json({ message: "Refresh token is required." });
  }
  try {
    const userId = await verifyRefreshToken(incomingToken);
    if (!userId) {
      await revokeRefreshToken(incomingToken);
      return res.status(401).json({ message: "Refresh token is invalid." });
    }
    const userQuery = await pool.query(
      "SELECT id, username, email, role FROM users WHERE id = $1",
      [userId]
    );
    const user = userQuery.rows[0];
    if (!user) {
      await revokeRefreshToken(incomingToken);
      return res.status(404).json({ message: "User not found." });
    }
    await revokeRefreshToken(incomingToken);
    const tokenBundle = await issueSessionTokens(user, res);
    res.json({
      message: "Token refreshed.",
      token: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      user,
    });
  } catch (err) {
    console.error("Token refresh failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/auth/logout", authenticateToken, async (req, res) => {
  try {
    const incomingToken =
      req.cookies[REFRESH_COOKIE_NAME] || req.body.refreshToken;
    if (incomingToken) {
      await revokeRefreshToken(incomingToken);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
    res.status(204).end();
  } catch (err) {
    console.error("Logout failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post(
  "/api/auth/request-password-reset",
  passwordResetLimiter,
  async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const userQuery = await pool.query(
        "SELECT id, email FROM users WHERE email = $1",
        [normalizedEmail]
      );
      const user = userQuery.rows[0];
      if (user) {
        const resetToken = crypto.randomBytes(32).toString("hex");
        await pool.query(
          `UPDATE users
           SET password_reset_token = $1,
               password_reset_expires = NOW() + INTERVAL '1 hour'
           WHERE id = $2`,
          [hashTokenValue(resetToken), user.id]
        );
        await sendPasswordResetEmail(user.email, resetToken);
      }
      res.json({
        message:
          "If that email exists in our system, a reset link has been sent.",
      });
    } catch (err) {
      console.error("Password reset request failed:", err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res
      .status(400)
      .json({ message: "Token and new password are required." });
  }
  try {
    const userQuery = await pool.query(
      `SELECT id FROM users
       WHERE password_reset_token = $1
         AND password_reset_expires > NOW()`,
      [hashTokenValue(token)]
    );
    const user = userQuery.rows[0];
    if (!user) {
      return res
        .status(400)
        .json({ message: "Reset link is invalid or has expired." });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           password_reset_token = NULL,
           password_reset_expires = NULL
       WHERE id = $2`,
      [hashedPassword, user.id]
    );
    await revokeAllRefreshTokensForUser(user.id);
    res.json({ message: "Password reset successful. Please log in again." });
  } catch (err) {
    console.error("Password reset failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      message: "Current and new passwords are required.",
    });
  }
  try {
    const userQuery = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id]
    );
    const user = userQuery.rows[0];
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [hashedPassword, req.user.id]
    );
    await revokeAllRefreshTokensForUser(req.user.id);
    res.json({ message: "Password updated. Please log in again." });
  } catch (err) {
    console.error("Change password failed:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/questions", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { taskType, difficulty, tag, search, onlyUnseen } = req.query;
    const filters = [];
    const values = [userId];
    let paramIndex = 2;

    if (taskType) {
      filters.push(`q.task_type = $${paramIndex}`);
      values.push(taskType);
      paramIndex++;
    }
    if (difficulty) {
      filters.push(`q.difficulty = $${paramIndex}`);
      values.push(difficulty);
      paramIndex++;
    }
    if (tag) {
      filters.push(`$${paramIndex} = ANY(q.tags)`);
      values.push(tag);
      paramIndex++;
    }
    if (search) {
      filters.push(
        `(q.title ILIKE $${paramIndex} OR q.topic ILIKE $${paramIndex})`
      );
      values.push(`%${search}%`);
      paramIndex++;
    }
    if (String(onlyUnseen).toLowerCase() === "true") {
      filters.push("r.user_id IS NULL");
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const sql = `
      SELECT
        q.id,
        q.title,
        q.topic,
        q.task_type,
        q.difficulty,
        q.tags,
        CASE WHEN r.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_completed
      FROM questions q
      LEFT JOIN (
        SELECT DISTINCT question_id, user_id FROM responses WHERE user_id = $1
      ) r ON q.id = r.question_id
      ${whereClause}
      ORDER BY q.id;
    `;
    const result = await pool.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get question list:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/questions/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM questions WHERE id = $1`, [
      id,
    ]);
    if (result.rows.length === 0)
      return res.status(404).json({ message: "Question not found." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`Failed to get question detail ID ${id}:`, err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/questions/meta/tags", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT UNNEST(tags) AS tag FROM questions WHERE array_length(tags, 1) IS NOT NULL ORDER BY tag`
    );
    res.json(result.rows.map((row) => row.tag));
  } catch (err) {
    console.error("Failed to get tag list:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post(
  "/api/questions",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const {
      title,
      topic,
      task_type,
      difficulty,
      tags,
      reading_passage,
      lecture_script,
      professor_prompt,
      student1_author,
      student1_post,
      student2_author,
      student2_post,
    } = req.body;
    if (!title || !topic || !task_type) {
      return res.status(400).json({
        message: "Title, topic, and task_type are required.",
      });
    }
    if (
      !["integrated_writing", "academic_discussion"].includes(task_type)
    ) {
      return res.status(400).json({ message: "Invalid task_type provided." });
    }
    try {
      const insertSql = `
        INSERT INTO questions
          (title, topic, task_type, difficulty, tags, reading_passage, lecture_script,
           professor_prompt, student1_author, student1_post, student2_author, student2_post)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *;
      `;
      const values = [
        title,
        topic,
        task_type,
        difficulty || null,
        parseTagArray(tags),
        reading_passage || null,
        lecture_script || null,
        professor_prompt || null,
        student1_author || null,
        student1_post || null,
        student2_author || null,
        student2_post || null,
      ];
      const result = await pool.query(insertSql, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Failed to create question:", err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.put(
  "/api/questions/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const allowedFields = [
      "title",
      "topic",
      "task_type",
      "difficulty",
      "tags",
      "reading_passage",
      "lecture_script",
      "professor_prompt",
      "student1_author",
      "student1_post",
      "student2_author",
      "student2_post",
    ];
    const sets = [];
    const values = [];
    let paramIndex = 1;
    allowedFields.forEach((field) => {
      if (field in req.body) {
        let value = req.body[field];
        if (field === "tags") {
          value = parseTagArray(value);
        }
        sets.push(`${field} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });
    if (!sets.length) {
      return res
        .status(400)
        .json({ message: "No updatable fields were provided." });
    }
    values.push(id);
    try {
      const result = await pool.query(
        `UPDATE questions SET ${sets.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
        values
      );
      if (!result.rows.length) {
        return res.status(404).json({ message: "Question not found." });
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error(`Failed to update question #${id}:`, err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.delete(
  "/api/questions/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query("DELETE FROM questions WHERE id = $1", [
        id,
      ]);
      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Question not found." });
      }
      res.status(204).end();
    } catch (err) {
      console.error(`Failed to delete question #${id}:`, err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.post(
  "/api/questions/:id/trigger-audio-generation",
  authenticateToken,
  (req, res) => {
    const { id } = req.params;
    console.log(
      `?? [HTTP] Received trigger for audio generation for question #${id}.`
    );
    generateAudioInBackground(id);
    res.status(202).json({ message: "Audio generation process started." });
  }
);

app.get(
  "/api/questions/:id/audio-status",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        "SELECT lecture_audio_url FROM questions WHERE id = $1",
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Question not found." });
      }
      res.json({ lecture_audio_url: result.rows[0].lecture_audio_url });
    } catch (error) {
      console.error(`Failed to poll audio status for question #${id}:`, error);
      res.status(500).json({ message: "Failed to get audio status." });
    }
  }
);

app.post(
  "/api/questions/:id/generate-model-essay",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    console.log(
      `?? [MODEL ESSAY API] Received request to generate essay for question #${id}.`
    );

    try {
      const questionResult = await pool.query(
        "SELECT * FROM questions WHERE id = $1",
        [id]
      );
      if (questionResult.rows.length === 0) {
        return res.status(404).json({ message: "Question not found." });
      }
      const question = questionResult.rows[0];

      let promptText =
        question.task_type === "integrated_writing"
          ? `Reading: ${question.reading_passage}\nLecture: ${question.lecture_script}`
          : `Professor's Prompt: ${question.professor_prompt}\n${question.student1_author}'s Post: ${question.student1_post}\n${question.student2_author}'s Post: ${question.student2_post}`;

      const aiResult = await callAIGenerateEssayAPI(
        promptText,
        question.task_type
      );
      const newModelEssay = aiResult.essayText;

      if (!newModelEssay || newModelEssay.trim() === "") {
        throw new Error("AI returned an empty essay.");
      }

      await pool.query("UPDATE questions SET model_essay = $1 WHERE id = $2", [
        newModelEssay,
        id,
      ]);

      console.log(
        `? [MODEL ESSAY API] Successfully generated and saved new essay for question #${id}.`
      );

      res.json({ modelEssay: newModelEssay });
    } catch (err) {
      console.error(
        `? [MODEL ESSAY API] Failed to generate essay for question #${id}:`,
        err.message
      );
      res.status(500).json({ message: "Failed to generate AI model essay." });
    }
  }
);

app.get("/api/drafts/:questionId", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const questionId = parseInt(req.params.questionId, 10);
  if (Number.isNaN(questionId)) {
    return res.status(400).json({ message: "Invalid question id." });
  }
  try {
    const result = await pool.query(
      `SELECT content, word_count, task_type, updated_at
       FROM writing_drafts
       WHERE user_id = $1 AND question_id = $2`,
      [userId, questionId]
    );
    if (!result.rows.length) {
      return res.json(null);
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to fetch draft:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.put("/api/drafts/:questionId", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const questionId = parseInt(req.params.questionId, 10);
  if (Number.isNaN(questionId)) {
    return res.status(400).json({ message: "Invalid question id." });
  }
  const { content = "", wordCount = 0, taskType } = req.body;
  if (!taskType) {
    return res.status(400).json({ message: "taskType is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO writing_drafts (user_id, question_id, task_type, content, word_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, question_id)
       DO UPDATE SET content = EXCLUDED.content,
                     word_count = EXCLUDED.word_count,
                     task_type = EXCLUDED.task_type,
                     updated_at = NOW()
       RETURNING content, word_count, updated_at`,
      [userId, questionId, taskType, content, wordCount]
    );
    res.json({
      message: "Draft saved.",
      draft: result.rows[0],
    });
  } catch (err) {
    console.error("Failed to save draft:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.delete("/api/drafts/:questionId", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const questionId = parseInt(req.params.questionId, 10);
  if (Number.isNaN(questionId)) {
    return res.status(400).json({ message: "Invalid question id." });
  }
  try {
    await pool.query(
      "DELETE FROM writing_drafts WHERE user_id = $1 AND question_id = $2",
      [userId, questionId]
    );
    res.status(204).end();
  } catch (err) {
    console.error("Failed to delete draft:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/writing-test", authenticateToken, async (req, res) => {
  try {
    const sql = `(SELECT * FROM questions WHERE task_type = 'integrated_writing' ORDER BY RANDOM() LIMIT 1) UNION ALL (SELECT * FROM questions WHERE task_type = 'academic_discussion' ORDER BY RANDOM() LIMIT 1);`;
    const result = await pool.query(sql);
    if (result.rows.length < 2)
      return res.status(404).json({
        message:
          "Not enough questions in database to start a full writing test.",
      });
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
    const responseSql = `INSERT INTO responses (content, word_count, question_id, task_type, user_id, processing_status) VALUES ($1, $2, $3, $4, $5, 'processing') RETURNING id`;
    const responseResult = await pool.query(responseSql, [
      content || "",
      wordCount,
      qId,
      task_type,
      userId,
    ]);
    const newResponseId = responseResult.rows[0].id;
    await pool.query(
      "DELETE FROM writing_drafts WHERE user_id = $1 AND question_id = $2",
      [userId, qId]
    );
    res
      .status(201)
      .json({
        message: "Submission successful!",
        id: newResponseId,
        status: "processing",
      });
    console.log(
      `?? [BACKGROUND] Starting AI processing for new response #${newResponseId}...`
    );
    processResponseWithAI(newResponseId).catch((error) => {
      console.error(
        `? [BACKGROUND] Async processing crashed for response #${newResponseId}:`,
        error
      );
    });
  } catch (err) {
    console.error("Database insertion failed:", err);
    res.status(500).json({ message: "Internal server error." });
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

app.get(
  "/api/responses/:id/status",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        `SELECT id, processing_status, processing_error, ai_score
         FROM responses
         WHERE id = $1 AND user_id = $2`,
        [id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ message: "Response not found." });
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error(`Failed to get status for response #${id}:`, err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.post(
  "/api/responses/:id/rescore",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        "SELECT id FROM responses WHERE id = $1 AND user_id = $2",
        [id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ message: "Response not found." });
      }
      await pool.query(
        `UPDATE responses
         SET processing_status = 'processing', processing_error = NULL
         WHERE id = $1`,
        [id]
      );
      processResponseWithAI(id);
      res.json({ message: "Rescore queued.", status: "processing" });
    } catch (err) {
      console.error(`Failed to rescore response #${id}:`, err);
      res.status(500).json({ message: "Internal server error." });
    }
  }
);

app.post("/api/responses/:id/polish", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  console.log(
    `?? [POLISH API] Starting AI polish for response #${id} by user #${userId}...`
  );
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

    console.log(`? [POLISH API] Successfully polished response #${id}.`);
    res.json({ polishedText: aiResult.polishedText });
  } catch (err) {
    console.error(
      `? [POLISH API] AI polish failed for response #${id}:`,
      err.message
    );
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
  const { status, type } = req.query;
  const filters = ["m.user_id = $1"];
  const values = [userId];
  let paramIndex = 2;
  if (status && status !== "all") {
    filters.push(`m.status = $${paramIndex}`);
    values.push(status);
    paramIndex++;
  }
  if (type && type !== "all") {
    filters.push(`m.type = $${paramIndex}`);
    values.push(type);
    paramIndex++;
  }
  const whereClause = `WHERE ${filters.join(" AND ")}`;
  try {
    const sql = `
      SELECT m.id, m.type, m.sub_type, m.original_text, m.corrected_text,
             m.explanation, m.created_at, m.response_id, m.status,
             q.title as question_title
      FROM mistakes m
      JOIN responses r ON m.response_id = r.id
      JOIN questions q ON r.question_id = q.id
      ${whereClause}
      ORDER BY m.created_at DESC;
    `;
    const result = await pool.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to get mistakes:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.patch("/api/mistakes/:id", authenticateToken, async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!MISTAKE_STATUSES.includes(status)) {
    return res.status(400).json({ message: "Invalid mistake status." });
  }
  try {
    const result = await pool.query(
      `UPDATE mistakes
       SET status = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, status`,
      [status, id, req.user.id]
    );
    if (!result.rows.length) {
      return res
        .status(404)
        .json({ message: "Mistake not found or not owned by user." });
    }
    res.json({
      message: "Mistake updated.",
      mistake: result.rows[0],
    });
  } catch (err) {
    console.error("Failed to update mistake:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/user/profile", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, bio, avatar_url, email_verified, last_login_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to fetch profile:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.put("/api/user/profile", authenticateToken, async (req, res) => {
  const { username, bio, avatarUrl, email } = req.body;
  if (
    username === undefined &&
    bio === undefined &&
    avatarUrl === undefined &&
    email === undefined
  ) {
    return res.status(400).json({ message: "No profile fields provided." });
  }
  try {
    const currentResult = await pool.query(
      "SELECT username, email FROM users WHERE id = $1",
      [req.user.id]
    );
    const currentUser = currentResult.rows[0];
    if (!currentUser) {
      return res.status(404).json({ message: "User not found." });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (username && username !== currentUser.username) {
      const dupUser = await pool.query(
        "SELECT 1 FROM users WHERE username = $1 AND id <> $2",
        [username, req.user.id]
      );
      if (dupUser.rows.length) {
        return res.status(409).json({ message: "Username already in use." });
      }
      updates.push(`username = $${paramIndex}`);
      values.push(username);
      paramIndex++;
    }
    if (email && email !== currentUser.email) {
      const normalizedEmail = email.trim().toLowerCase();
      const emailDup = await pool.query(
        "SELECT 1 FROM users WHERE email = $1 AND id <> $2",
        [normalizedEmail, req.user.id]
      );
      if (emailDup.rows.length) {
        return res.status(409).json({ message: "Email already in use." });
      }
      updates.push(`email = $${paramIndex}`);
      values.push(normalizedEmail);
      paramIndex++;
      updates.push(`email_verified = FALSE`);
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramIndex}`);
      values.push(bio);
      paramIndex++;
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex}`);
      values.push(avatarUrl);
      paramIndex++;
    }

    if (!updates.length) {
      return res
        .status(400)
        .json({ message: "No changes detected in profile update." });
    }
    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${
        values.length
      } RETURNING id, username, email, bio, avatar_url, email_verified, last_login_at`,
      values
    );
    res.json({
      message: "Profile updated successfully.",
      profile: result.rows[0],
    });
  } catch (err) {
    console.error("Failed to update profile:", err);
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
    const result = await pool.query(
      "SELECT last_analysis_result FROM users WHERE id = $1",
      [userId]
    );
    const analysis = result.rows[0]?.last_analysis_result;

    if (analysis) {
      res.json(analysis);
    } else {
      res.status(404).json({ message: "No analysis found for this user." });
    }
  } catch (err) {
    console.error("? Failed to get stored writing analysis:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/user/writing-analysis", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  console.log(`?? [ANALYSIS API] Starting new analysis for user #${userId}...`);
  try {
    const responsesQuery = await pool.query(
      "SELECT content, ai_feedback FROM responses WHERE user_id = $1 AND content IS NOT NULL AND content != '' AND ai_feedback IS NOT NULL AND ai_feedback LIKE '{%}'",
      [userId]
    );

    if (responsesQuery.rows.length < 3) {
      return res.status(400).json({
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

    const responseData = {
      wordCloud: wordCloudData,
      commonMistakes: aiAnalysis.analysis,
      analyzedAt: new Date().toISOString(),
    };

    await pool.query(
      "UPDATE users SET last_analysis_result = $1, last_analysis_at = NOW() WHERE id = $2",
      [JSON.stringify(responseData), userId]
    );

    console.log(
      `? [ANALYSIS API] Generated and saved new analysis for user #${userId}.`
    );
    res.json(responseData);
  } catch (err) {
    console.error(
      `? [ANALYSIS API] Failed to generate writing analysis for user #${userId}:`,
      err.message
    );
    res
      .status(500)
      .json({ message: "Internal server error during analysis generation." });
  }
});

app.get("/health", async (req, res) => {
  const payload = {
    status: "ok",

    version: appVersion,

    uptime: process.uptime(),

    timestamp: new Date().toISOString(),
  };

  try {
    await pool.query("SELECT 1");

    payload.database = "connected";

    res.json(payload);
  } catch (error) {
    payload.database = "error";

    payload.error = error.message;

    res.status(503).json(payload);
  }
});

app.use(express.static("public"));

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`?? Server is running on port ${PORT}`);

    console.log(`==> Your service is live ?`);

    console.log(`==>`);

    console.log(
      `==> //////////////////////////////////////////////////////////////`
    );

    console.log(`==>`);

    console.log(
      `==> Available at your primary URL: https://toefl-final-project.onrender.com`
    );

    console.log(`==>`);

    console.log(
      `==> //////////////////////////////////////////////////////////////`
    );

    console.log(`==>`);
  });
}

module.exports = { app, pool };


