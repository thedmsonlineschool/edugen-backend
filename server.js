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

  // Normalize separators
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

  // Split by bullets, dashes, or newlines
  const items = text
    .split(/\n|(?=[•\-▪◦])/)
    .map(item => item.replace(/^[•\-▪◦]\s*/, '').trim())
    .filter(item => item.length > 2);

  return items;
}

/* ============================================================
   CBC SYLLABUS TABLE PARSER
   Parses HTML tables from mammoth.convertToHtml()
   Option A: Each row = ONE specific competence
============================================================ */
function parseCBCSyllabusTable(html, subject) {
  const $ = cheerio.load(html);

  const topics = [];
  let currentTopic = null;
  let currentSubtopic = null;

  // Process each table row
  $('table tr').each((rowIndex, row) => {
    const cells = $(row).find('td, th');
    
    if (cells.length < 2) return;

    // Debug logging
    console.log(
      cells.map((i, c) => extractText($(c).html())).get()
    );

    // Check if this is a header row by content
    const firstCellText = extractText($(cells[0]).html()).toLowerCase();
    if (
      firstCellText.includes('topic') ||
      firstCellText.includes('sub-topic') ||
      firstCellText.includes('subtopic') ||
      firstCellText.includes('specific competence') ||
      firstCellText.includes('learning activit') ||
      firstCellText.includes('expected standard')
    ) {
      return; // Skip header rows
    }

    // Extract cell contents based on column position
    // Columns: Topic | Subtopic | Specific Competences | Learning Activities | Expected Standards
    const topicCell = $(cells[0]).html() || '';
    const subtopicCell = $(cells[1]).html() || '';
    const competencesCell = $(cells[2]).html() || '';
    const activitiesCell = cells[3] ? $(cells[3]).html() || '' : '';
    const standardsCell = cells[4] ? $(cells[4]).html() || '' : '';

    // Parse topic text
    const topicText = extractText(topicCell).trim();
    
    // Topic handling: create or reuse
    if (topicText) {
      const existing = topics.find(t => t.name === topicText);
      if (existing) {
        currentTopic = existing;
      } else {
        currentTopic = { name: topicText, subtopics: [] };
        topics.push(currentTopic);
        currentSubtopic = null; // Reset subtopic when new topic starts
      }
    }

    // Skip row if no topic context exists
    if (!currentTopic) {
      return;
    }

    // Parse subtopic text
    const subtopicText = extractText(subtopicCell).trim();
    
    // Subtopic handling: create or reuse
    if (subtopicText) {
      const existingSubtopic = currentTopic.subtopics.find(s => s.name === subtopicText);
      if (existingSubtopic) {
        currentSubtopic = existingSubtopic;
      } else {
        currentSubtopic = {
          name: subtopicText,
          specificCompetences: []
        };
        currentTopic.subtopics.push(currentSubtopic);
      }
    }

    // Skip row if no subtopic context exists
    if (!currentSubtopic) {
      return;
    }

    // Option A: Each row = ONE specific competence
    // Treat entire competences cell as one description
    const competenceDescription = extractText(competencesCell).trim();
    const learningActivities = splitBulletContent(activitiesCell);
    const expectedStandards = splitBulletContent(standardsCell);

    // Only create a specific competence if there's a description
    if (competenceDescription) {
      const specificCompetence = {
        description: competenceDescription,
        learningActivities: learningActivities,
        expectedStandards: expectedStandards
      };
      currentSubtopic.specificCompetences.push(specificCompetence);
    }
  });

  // Return null if no topics were parsed
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
        // OBC syllabus fields
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

      // OBC syllabus handling
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
      // CBC syllabi are TABLE-BASED → use HTML table parser
      const result = await mammoth.convertToHtml({
        buffer: req.file.buffer
      });

      console.log('📄 CBC HTML preview:', result.value.substring(0, 500));

      parsed = parseCBCSyllabusTable(result.value, subject);

    } else {
      // OBC syllabi are TEXT-BASED
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
      rawHtml: result.value,
      parsed: parsed
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -----------------------------
   START SERVER
------------------------------ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 EduGen AI backend running on port ${PORT}`);
});
