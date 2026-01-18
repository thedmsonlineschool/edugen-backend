require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------
   DATABASE SETUP
---------------------------------- */
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const syllabusSchema = new mongoose.Schema({
  subject: String,
  curriculumType: String,
  topics: Array
});

const Syllabus = mongoose.model('Syllabus', syllabusSchema);

/* ---------------------------------
   FILE UPLOAD (WORD ONLY)
---------------------------------- */
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.docx$/)) {
      cb(new Error('Only Word (.docx) files are allowed'));
    }
    cb(null, true);
  }
});

/* ---------------------------------
   CORE PARSER (ROBUST)
---------------------------------- */
function parseZambianSyllabus(rawText, curriculum, subject) {

  // 1. NORMALISE TEXT
  const clean = rawText
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[•]/g, '•')
    .trim();

  const lines = clean
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const topics = [];

  let currentTopic = null;
  let currentSubtopic = null;
  let currentOutcome = null;
  let pendingNumber = null;

  const isGradeNumber = n => /^(10|11|12)\./.test(n);
  const getLevel = n => n.split('.').length;

  const numberOnly = line =>
    /^((10|11|12)(\.\d+){1,3})$/.test(line);

  const extract = line => {
    const m = line.match(/^((10|11|12)(\.\d+){1,3})\s*(.*)$/);
    return m ? { number: m[1], text: m[4]?.trim() || '' } : null;
  };

  const classify = text => {
    const t = text.toLowerCase();
    if (t.startsWith('appreciat') || t.startsWith('value'))
      return 'values';
    if (t.startsWith('measure') || t.startsWith('calculate') || t.startsWith('demonstrate'))
      return 'skills';
    return 'knowledge';
  };

  for (const line of lines) {

    // Skip headers
    if (/topic|content|physics|syllabus|grade/i.test(line)) continue;

    // Broken-number line
    if (numberOnly(line)) {
      pendingNumber = line;
      continue;
    }

    let parsed = extract(line);

    if (!parsed && pendingNumber) {
      parsed = { number: pendingNumber, text: line };
      pendingNumber = null;
    }

    if (parsed && isGradeNumber(parsed.number)) {

      const level = getLevel(parsed.number);
      const fullText = `${parsed.number} ${parsed.text}`.trim();

      // TOPIC
      if (level === 2) {
        currentTopic = {
          number: parsed.number,
          name: fullText,
          subtopics: []
        };
        topics.push(currentTopic);
        currentSubtopic = null;
        currentOutcome = null;
        continue;
      }

      // SUBTOPIC
      if (
        level === 3 &&
        currentTopic &&
        parsed.number.startsWith(currentTopic.number)
      ) {
        currentSubtopic = {
          number: parsed.number,
          name: fullText,
          specificOutcomes: [],
          knowledge: [],
          skills: [],
          values: []
        };
        currentTopic.subtopics.push(currentSubtopic);
        currentOutcome = null;
        continue;
      }

      // OUTCOME
      if (
        level === 4 &&
        currentSubtopic &&
        parsed.number.startsWith(currentSubtopic.number)
      ) {
        currentOutcome = {
          number: parsed.number,
          text: fullText,
          content: []
        };
        currentSubtopic.specificOutcomes.push(currentOutcome);
        continue;
      }
    }

    // CONTENT
    if (
      currentOutcome &&
      (line.startsWith('•') || line.startsWith('-'))
    ) {
      const content = line.replace(/^[-•]\s*/, '').trim();
      if (content.length > 3) {
        currentOutcome.content.push(content);
        if (curriculum === 'obc') {
          const bucket = classify(content);
          currentSubtopic[bucket].push(content);
        }
      }
    }
  }

  return topics.length
    ? { subject, curriculumType: curriculum, topics }
    : null;
}

/* ---------------------------------
   UPLOAD ENDPOINT
---------------------------------- */
app.post('/upload-syllabus', upload.single('file'), async (req, res) => {
  try {
    const { curriculum, subject } = req.body;

    const result = await mammoth.extractRawText({
      buffer: req.file.buffer
    });

    const parsed = parseZambianSyllabus(
      result.value,
      curriculum,
      subject
    );

    if (!parsed) {
      return res.status(400).json({ error: 'Parsing failed' });
    }

    const saved = await Syllabus.create(parsed);
    res.json({ success: true, data: saved });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------
   SERVER START
---------------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`EduGen AI server running on port ${PORT}`)
);
