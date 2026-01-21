require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');

/* ================================
   🔹 ADD: Claude SDK import
================================ */
const Anthropic = require('@anthropic-ai/sdk');

const Syllabus = require('./models/Syllabus');

const app = express();

/* ================================
   🔹 ADD: Initialise Claude client
   (uses Railway variable)
================================ */
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

/* -----------------------------
   CORS CONFIG (STACKBLITZ + LOCAL)
------------------------------ */
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://vitejsviterbquwxee-oc5q--5173--31fc58ec.local-credentialless.webcontainer.io'
  ],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

/* -----------------------------
   DATABASE CONNECTION
------------------------------ */
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected successfully'))
.catch(err => {
  console.error('❌ MongoDB connection error');
  console.error(err);
});

/* -----------------------------
   FILE UPLOAD (DOCX ONLY)
------------------------------ */
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith('.docx')) {
      return cb(new Error('Only Word (.docx) files are allowed'));
    }
    cb(null, true);
  }
});

/* ============================================================
   ZAMBIAN SYLLABUS PARSER
============================================================ */
function parseZambianSyllabus(rawText, curriculum, subject) {

  let text = rawText
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[•]/g, '•');

  text = text.replace(/((10|11|12)\.\d+(\.\d+){0,2})/g, '\n$1');

  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const topics = [];
  let currentTopic = null;
  let currentSubtopic = null;
  let pendingNumber = null;

  const numberOnly = line =>
    /^((10|11|12)(\.\d+){1,3})$/.test(line);

  const extract = line => {
    const m = line.match(/^((10|11|12)(\.\d+){1,3})\s*(.*)$/);
    return m ? { number: m[1], text: m[4] || '' } : null;
  };

  for (const line of lines) {

    if (/^topic$|^sub\s*topic$|^specific outcomes?$|^content$/i.test(line)) {
      continue;
    }

    if (numberOnly(line)) {
      pendingNumber = line;
      continue;
    }

    let parsed = extract(line);

    if (!parsed && pendingNumber) {
      parsed = { number: pendingNumber, text: line };
      pendingNumber = null;
    }

    if (!parsed) continue;

    const level = parsed.number.split('.').length;
    const fullText = `${parsed.number} ${parsed.text}`.trim();

    if (level === 2) {
      currentTopic = { name: fullText, subtopics: [] };
      topics.push(currentTopic);
      currentSubtopic = null;
      continue;
    }
if (level === 3 && currentTopic) {
  currentSubtopic = {
    name: fullText,

    // ===== CBC syllabus fields =====
    specificCompetences: [],
    learningActivities: [],
    expectedStandards: [],

    // ===== OBC syllabus fields =====
    specificOutcomes: [],
    knowledge: [],
    skills: [],
    values: []
  };

  currentTopic.subtopics.push(currentSubtopic);
  continue;
}

    if (level === 4 && currentSubtopic) {
      currentSubtopic.specificOutcomes.push(fullText);
      continue;
    }
if (currentSubtopic && (line.startsWith('•') || line.startsWith('-'))) {
  const content = line.replace(/^[-•]\s*/, '').trim();
  if (content.length < 3) continue;

  const lower = content.toLowerCase();

  // ===== CBC syllabus handling =====
  if (curriculum === 'cbc') {
    if (
      lower.includes('explain') ||
      lower.includes('describe') ||
      lower.includes('define') ||
      lower.includes('identify') ||
      lower.includes('state') ||
      lower.includes('outline') ||
      lower.includes('analyse') ||
      lower.includes('analyze') ||
      lower.includes('evaluate') ||
      lower.includes('apply') ||
      lower.startsWith('demonstrate ability')
    ) {
      currentSubtopic.specificCompetences.push(content);
    } else if (
      lower.includes('demonstrat') ||
      lower.includes('discuss') ||
      lower.includes('investigat') ||
      lower.includes('perform') ||
      lower.includes('observe') ||
      lower.includes('experiment') ||
      lower.includes('group work') ||
      lower.includes('practical')
    ) {
      currentSubtopic.learningActivities.push(content);
    } else {
      currentSubtopic.expectedStandards.push(content);
    }
  }

  // ===== OBC syllabus handling =====
  if (curriculum === 'obc') {
    if (lower.startsWith('appreciat') || lower.startsWith('value')) {
      currentSubtopic.values.push(content);
    } else if (
      lower.startsWith('measure') ||
      lower.startsWith('calculate') ||
      lower.startsWith('demonstrate')
    ) {
      currentSubtopic.skills.push(content);
    } else {
      currentSubtopic.knowledge.push(content);
    }
  }
}
  }

  if (!topics.length) return null;

  return {
    subject,
    curriculumType: curriculum,
    form: curriculum === 'cbc' ? 'Form 1' : 'Grade 10',
    topics
  };
}

/* ============================================================
   API ROUTES
============================================================ */

/* ---- PARSE & SAVE SYLLABUS ---- */
app.post('/api/syllabi/parse', upload.single('file'), async (req, res) => {
  try {
    const { curriculum, subject } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

let parsed;

if (curriculum === 'cbc') {
  // CBC syllabi are TABLE-BASED → preserve structure
  const result = await mammoth.convertToHtml({
    buffer: req.file.buffer
  });

  parsed = parseZambianSyllabus(
    result.value,   // HTML with <table><tr><td>
    curriculum,
    subject
  );

} else {
  // OBC syllabi are TEXT-BASED
  const result = await mammoth.extractRawText({
    buffer: req.file.buffer
  });

  parsed = parseZambianSyllabus(
    result.value,
    curriculum,
    subject
  );
}

    if (!parsed) return res.status(400).json({ error: 'Parsing failed' });

    const saved = await Syllabus.create(parsed);
    res.json({ success: true, syllabus: saved });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- 🔹 ADD: GENERATE DOCUMENT (CLAUDE) ---- */
app.post('/api/generate-document', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 4096,
      temperature: 0.4,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const text =
      response.content &&
      response.content[0] &&
      response.content[0].text;

    res.json({ content: text || '' });

  } catch (err) {
    console.error('❌ Claude generation error:', err);
    res.status(500).json({ error: 'Document generation failed' });
  }
});

/* ---- GET ALL SYLLABI ---- */
app.get('/api/syllabi', async (req, res) => {
  const syllabi = await Syllabus.find().sort({ createdAt: -1 });
  res.json(syllabi);
});

/* ---- GET SINGLE SYLLABUS ---- */
app.get('/api/syllabi/:id', async (req, res) => {
  const syllabus = await Syllabus.findById(req.params.id);
  res.json(syllabus);
});

/* ---- DELETE SYLLABUS ---- */
app.delete('/api/syllabi/:id', async (req, res) => {
  await Syllabus.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

/* ---- HEALTH CHECK ---- */
app.get('/ping', (req, res) => {
  res.json({ message: 'EduGen backend is alive' });
});

/* -----------------------------
   START SERVER
------------------------------ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 EduGen AI backend running on port ${PORT}`);
});
