require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');

const Syllabus = require('./models/Syllabus');

const app = express();

/* -----------------------------
   CORS (STACKBLITZ + LOCAL)
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
   DATABASE CONNECTION (✅ FIXED)
------------------------------ */
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

/* -----------------------------
   FILE UPLOAD (DOCX ONLY)
------------------------------ */
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith('.docx')) {
      cb(new Error('Only Word (.docx) files are allowed'));
    }
    cb(null, true);
  }
});

/* ============================================================
   PARSER FUNCTION (ZAMBIAN SYLLABUS)
============================================================ */
function parseZambianSyllabus(rawText, curriculum, subject) {

  let text = rawText
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[•]/g, '•');

  // Force new lines before numbers like 10.1, 10.1.1, etc.
  text = text.replace(/((10|11|12)\.\d+(\.\d+){0,2})/g, '\n$1');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

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
      currentTopic = {
        name: fullText,
        subtopics: []
      };
      topics.push(currentTopic);
      currentSubtopic = null;
      continue;
    }

    if (level === 3 && currentTopic) {
      currentSubtopic = {
        name: fullText,
        competencies: [],
        scopeOfLessons: [],
        activities: [],
        expectedStandards: [],
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

  if (!topics.length) {
    console.error('❌ Parsing failed: No topics detected');
    return null;
  }

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

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = await mammoth.extractRawText({
      buffer: req.file.buffer
    });

    const parsed
