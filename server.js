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

/* ---- Helper: Detect numbering level from text ---- */
function getNumberingInfo(text) {
  if (!text) return { level: 0, number: null, content: text };
  
  // Match patterns like 1.1, 1.1.1, 1.1.1.1 at the start
  const match = text.match(/^(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\s*(.*)/s);
  if (!match) return { level: 0, number: null, content: text };
  
  const number = match[1];
  const content = match[2] || '';
  const parts = number.split('.');
  
  return {
    level: parts.length, // 2 = Topic, 3 = Subtopic, 4 = Specific Competence
    number: number,
    content: text // Keep full text including number
  };
}

/* ---- Helper: Check if text is a header row ---- */
function isHeaderRow(cells) {
  const combined = cells.join(' ').toLowerCase();
  return (
    (combined.includes('topic') && combined.includes('sub')) ||
    combined.includes('specific competence') ||
    combined.includes('specificcompetence') ||
    combined.includes('learning activit') ||
    combined.includes('expected standard') ||
    combined.includes('expectedstandard')
  );
}

/* ============================================================
   CBC SYLLABUS TABLE PARSER
   Parses HTML tables from mammoth.convertToHtml()
   
   KEY INSIGHT: Mammoth shifts cells left when Word has merged cells.
   So we detect content by NUMBERING PATTERN, not column position.
   
   Numbering:
   - X.Y = Topic (2 parts)
   - X.Y.Z = Subtopic (3 parts)  
   - X.Y.Z.W = Specific Competence (4 parts)
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
    
    if (cells.length < 2) return;

    // Extract text from all cells
    const cellTexts = [];
    const cellHtmls = [];
    cells.each((i, cell) => {
      cellTexts.push(extractText($(cell).html()));
      cellHtmls.push($(cell).html() || '');
    });

    // Skip header rows
    if (isHeaderRow(cellTexts)) {
      return;
    }

    // Log first 15 rows for debugging
    if (rowCount < 15) {
      console.log(`Row ${rowCount}:`, cellTexts.map(t => t.substring(0, 40)));
    }
    rowCount++;

    // Analyze each cell to find Topic, Subtopic, Competence by numbering
    let foundTopic = null;
    let foundSubtopic = null;
    let foundCompetence = null;
    let competenceIndex = -1;

    for (let i = 0; i < cellTexts.length; i++) {
      const info = getNumberingInfo(cellTexts[i]);
      
      if (info.level === 2 && !foundTopic) {
        foundTopic = cellTexts[i];
      } else if (info.level === 3 && !foundSubtopic) {
        foundSubtopic = cellTexts[i];
      } else if (info.level === 4 && !foundCompetence) {
        foundCompetence = cellTexts[i];
        competenceIndex = i;
      }
    }

    // Process TOPIC (X.Y pattern)
    if (foundTopic) {
      const existing = topics.find(t => t.name === foundTopic);
      if (existing) {
        currentTopic = existing;
      } else {
        currentTopic = { name: foundTopic, subtopics: [] };
        topics.push(currentTopic);
        currentSubtopic = null;
      }
    }

    // Process SUBTOPIC (X.Y.Z pattern)
    if (foundSubtopic && currentTopic) {
      const existingSubtopic = currentTopic.subtopics.find(s => s.name === foundSubtopic);
      if (existingSubtopic) {
        currentSubtopic = existingSubtopic;
      } else {
        currentSubtopic = {
          name: foundSubtopic,
          specificCompetences: []
        };
        currentTopic.subtopics.push(currentSubtopic);
      }
    }

    // Process SPECIFIC COMPETENCE (X.Y.Z.W pattern)
    if (foundCompetence && currentSubtopic) {
      // Learning activities and expected standards are in cells AFTER the competence
      let learningActivities = [];
      let expectedStandards = [];

      // The cell right after competence is usually learning activities
      if (competenceIndex + 1 < cellHtmls.length) {
        learningActivities = splitBulletContent(cellHtmls[competenceIndex + 1]);
      }
      
      // The cell after that is usually expected standards
      if (competenceIndex + 2 < cellHtmls.length) {
        expectedStandards = splitBulletContent(cellHtmls[competenceIndex + 2]);
      }

      // Check if this competence already exists (avoid duplicates)
      const existingCompetence = currentSubtopic.specificCompetences.find(
        c => c.description === foundCompetence
      );

      if (!existingCompetence) {
        const specificCompetence = {
          description: foundCompetence,
          learningActivities: learningActivities,
          expectedStandards: expectedStandards
        };
        currentSubtopic.specificCompetences.push(specificCompetence);
      }
    }
  });

  // Log summary
  let totalSubtopics = 0;
  let totalCompetences = 0;
  topics.forEach(t => {
    totalSubtopics += t.subtopics.length;
    t.subtopics.forEach(s => {
      totalCompetences += s.specificCompetences.length;
    });
  });
  
  console.log(`✅ CBC Parsing complete:`);
  console.log(`   - Topics: ${topics.length}`);
  console.log(`   - Subtopics: ${totalSubtopics}`);
  console.log(`   - Specific Competences: ${totalCompetences}`);

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
    const { curriculum, category, gradeRange, subject } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log('📝 Upload request:', { curriculum, category, gradeRange, subject });

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

    // ✨ NEW: Add category and gradeRange from the request
    parsed.category = category || 'secondary';
    parsed.gradeRange = gradeRange || 'N/A';
    
    console.log('💾 Saving syllabus with structure:', {
      subject: parsed.subject,
      curriculumType: parsed.curriculumType,
      category: parsed.category,
      gradeRange: parsed.gradeRange,
      topicsCount: parsed.topics?.length
    });

    const saved = await Syllabus.create(parsed);
    res.json({ success: true, syllabus: saved });

  } catch (err) {
    console.error('❌ Syllabus parsing error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ---- GENERATE DOCUMENT (CLAUDE API) ---- */
app.post('/api/generate-document', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Check if API key is configured
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ error: 'AI service not configured. Please set ANTHROPIC_API_KEY.' });
    }

    console.log('🤖 Generating document with Claude...');
    console.log('📝 Prompt length:', prompt.length);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Claude API error:', data);
      return res.status(500).json({ 
        error: data.error?.message || 'AI generation failed' 
      });
    }

    const content = data.content[0]?.text || '';
    console.log('✅ Document generated successfully, length:', content.length);
    
    res.json({ content });

  } catch (err) {
    console.error('❌ Document generation error:', err);
    res.status(500).json({ error: 'Failed to generate document. Please try again.' });
  }
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
