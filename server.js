require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const cheerio = require('cheerio');

const Syllabus = require('./models/Syllabus');

const app = express();

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
   HELPER FUNCTIONS FOR CBC TABLE PARSING
============================================================ */

/* ---- Helper: Extract plain text from HTML ---- */
function extractText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/* ---- Helper: Split bullets/line breaks into array ---- */
function splitBulletContent(html) {
  if (!html) return [];

  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '\n•')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const items = text
    .split(/\n|(?=[•\-▪◦])/)
    .map(item => item.replace(/^[•\-▪◦]\s*/, '').trim())
    .filter(item => item.length > 2);

  return items;
}

/* ---- Helper: Detect numbering level ---- */
function getNumberingLevel(text) {
  // Match patterns like 1.1, 1.1.1, 1.1.1.1
  const match = text.match(/^(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\s/);
  if (!match) return { level: 0, number: null };
  
  const number = match[1];
  const parts = number.split('.');
  
  return {
    level: parts.length, // 2 = Topic, 3 = Subtopic, 4 = Specific Competence
    number: number
  };
}

/* ---- Helper: Check if text is a header row ---- */
function isHeaderRow(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes('topic') && lower.includes('sub') ||
    lower === 'topic' ||
    lower === 'sub-topic' ||
    lower === 'subtopic' ||
    lower.includes('specific competence') ||
    lower.includes('specificcompetence') ||
    lower.includes('learning activit') ||
    lower.includes('expected standard')
  );
}

/* ============================================================
   CBC SYLLABUS TABLE PARSER
   Parses HTML tables from mammoth.convertToHtml()
   Uses numbering patterns: X.Y = Topic, X.Y.Z = Subtopic, X.Y.Z.W = Competence
============================================================ */
function parseCBCSyllabusTable(html, subject) {
  const $ = cheerio.load(html);

  const topics = [];
  let currentTopic = null;
  let currentSubtopic = null;
  let rowCount = 0;

  // Process each table row
  $('table tr').each((rowIndex, row) => {
    const cells = $(row).find('td, th');
    
    if (cells.length < 3) return;

    // Extract all cell contents
    const cell0 = extractText($(cells[0]).html());
    const cell1 = extractText($(cells[1]).html());
    const cell2 = extractText($(cells[2]).html());
    const cell3 = cells[3] ? extractText($(cells[3]).html()) : '';
    const cell4 = cells[4] ? extractText($(cells[4]).html()) : '';

    // Skip header rows
    if (isHeaderRow(cell0) || isHeaderRow(cell1) || isHeaderRow(cell2)) {
      return;
    }

    // Log only first 10 rows for debugging (reduced logging)
    if (rowCount < 10) {
      console.log(`Row ${rowCount}:`, [cell0.substring(0, 30), cell1.substring(0, 30), cell2.substring(0, 30)]);
    }
    rowCount++;

    // Get raw HTML for bullet point extraction
    const activitiesHtml = cells[3] ? $(cells[3]).html() : '';
    const standardsHtml = cells[4] ? $(cells[4]).html() : '';

    // Check each cell for numbering patterns
    const level0 = getNumberingLevel(cell0);
    const level1 = getNumberingLevel(cell1);
    const level2 = getNumberingLevel(cell2);

    // TOPIC: X.Y pattern (2 parts) - usually in column 0
    if (level0.level === 2 && cell0) {
      const existing = topics.find(t => t.name === cell0);
      if (existing) {
        currentTopic = existing;
      } else {
        currentTopic = { name: cell0, subtopics: [] };
        topics.push(currentTopic);
        currentSubtopic = null;
      }
    }

    // SUBTOPIC: X.Y.Z pattern (3 parts) - usually in column 1
    if (level1.level === 3 && cell1 && currentTopic) {
      const existingSubtopic = currentTopic.subtopics.find(s => s.name === cell1);
      if (existingSubtopic) {
        currentSubtopic = existingSubtopic;
      } else {
        currentSubtopic = {
          name: cell1,
          specificCompetences: []
        };
        currentTopic.subtopics.push(currentSubtopic);
      }
    }

    // SPECIFIC COMPETENCE: X.Y.Z.W pattern (4 parts) - usually in column 2
    if (level2.level === 4 && cell2 && currentSubtopic) {
      const learningActivities = splitBulletContent(activitiesHtml);
      const expectedStandards = splitBulletContent(standardsHtml);

      const specificCompetence = {
        description: cell2,
        learningActivities: learningActivities,
        expectedStandards: expectedStandards
      };
      currentSubtopic.specificCompetences.push(specificCompetence);
    }

    // Handle rows where Topic/Subtopic cells are empty (merged cells)
    // but there's still a specific competence
    if (!level0.level && !level1.level && level2.level === 4 && currentSubtopic) {
      const learningActivities = splitBulletContent(activitiesHtml);
      const expectedStandards = splitBulletContent(standardsHtml);

      const specificCompetence = {
        description: cell2,
        learningActivities: learningActivities,
        expectedStandards: expectedStandards
      };
      currentSubtopic.specificCompetences.push(specificCompetence);
    }
  });

  console.log(`✅ CBC Parsing complete: ${topics.length} topics found`);

  if (!topics.length) return null;

  return {
    subject,
    curriculumType: 'cbc',
    form: 'Form 1',
    topics
  };
}

/* ============================================================
   OBC ZAMBIAN SYLLABUS PARSER (TEXT-BASED)
============================================================ */
function parseOBCSyllabus(rawText, subject) {

  let text = rawText
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[•]/g, '•');

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

  if (!topics.length) return null;

  return {
    subject,
    curriculumType: 'obc',
    form: 'Grade 10',
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
      const result = await mammoth.convertToHtml({
        buffer: req.file.buffer
      });

      console.log('📄 CBC HTML length:', result.value.length);

      parsed = parseCBCSyllabusTable(result.value, subject);

    } else {
      const result = await mammoth.extractRawText({
        buffer: req.file.buffer
      });

      parsed = parseOBCSyllabus(result.value, subject);
    }

    if (!parsed) {
      return res.status(400).json({ 
        error: 'Parsing failed. Could not extract syllabus structure from the document.' 
      });
    }

    const saved = await Syllabus.create(parsed);
    res.json({ success: true, syllabus: saved });

  } catch (err) {
    console.error('❌ Syllabus parsing error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ---- GENERATE DOCUMENT (CLAUDE) ---- */
app.post('/api/generate-document', async (req, res) => {
  return res.status(501).json({
    error: 'AI generation temporarily disabled for backend stabilisation'
  });
});

/* ---- GET ALL SYLLABI ---- */
app.get('/api/syllabi', async (req, res) => {
  try {
    const syllabi = await Syllabus.find().sort({ createdAt: -1 });
    res.json(syllabi);
  } catch (err) {
    console.error('❌ Error fetching syllabi:', err);
    res.status(500).json({ error: 'Failed to fetch syllabi' });
  }
});

/* ---- GET SINGLE SYLLABUS ---- */
app.get('/api/syllabi/:id', async (req, res) => {
  try {
    const syllabus = await Syllabus.findById(req.params.id);
    if (!syllabus) {
      return res.status(404).json({ error: 'Syllabus not found' });
    }
    res.json(syllabus);
  } catch (err) {
    console.error('❌ Error fetching syllabus:', err);
    res.status(500).json({ error: 'Failed to fetch syllabus' });
  }
});

/* ---- DELETE SYLLABUS ---- */
app.delete('/api/syllabi/:id', async (req, res) => {
  try {
    await Syllabus.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error deleting syllabus:', err);
    res.status(500).json({ error: 'Failed to delete syllabus' });
  }
});

/* ---- HEALTH CHECK ---- */
app.get('/ping', (req, res) => {
  res.json({ message: 'EduGen backend is alive' });
});

/* ---- DEBUG: Test CBC Parser (for development) ---- */
app.post('/api/debug/parse-cbc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await mammoth.convertToHtml({
      buffer: req.file.buffer
    });

    const parsed = parseCBCSyllabusTable(result.value, 'Debug Subject');

    res.json({
      rawHtmlLength: result.value.length,
      parsed: parsed
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -----------------------------
   GLOBAL ERROR HANDLERS
------------------------------ */
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

/* -----------------------------
   START SERVER
------------------------------ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 EduGen AI backend running on port ${PORT}`);
});
