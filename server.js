require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth'); 
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import Model
const Syllabus = require('./models/Syllabus');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configure Multer
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } 
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- HELPER: CALL CLAUDE API ---
async function callClaude(prompt) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20240620',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API Error');
    return data.content[0].text;
  } catch (error) {
    console.error('Claude API Call Failed:', error);
    throw error;
  }
}

// --- HELPER: ZAMBIAN SYLLABUS SKELETON PARSER ---
// Strictly follows numbering. Ignores Content/Knowledge/Skills/Values to prevent errors.
function parseZambianSyllabus(text, curriculum, subject) {
  
  // 1. PRE-PROCESSING: Normalize text
  let cleanText = text
    .replace(/\r\n/g, '\n')
    // Force newlines before numbers to un-flatten PDF text
    .replace(/(\d+\.\d+\s)/g, '\n$1')       
    .replace(/(\d+\.\d+\.\d+\s)/g, '\n$1')  
    .replace(/(\d+\.\d+\.\d+\.\d+\s)/g, '\n$1');

  const lines = cleanText.split('\n');
  const topics = [];
  
  let currentTopic = null;
  let currentSubtopic = null;

  // Regex Patterns (Strict Numbering)
  // Matches "10.1" or "10.1." followed by text
  const topicRegex = /^\s*(\d+\.\d+)\.?\s+(.+)/;         
  const subtopicRegex = /^\s*(\d+\.\d+\.\d+)\.?\s+(.+)/; 
  const outcomeRegex = /^\s*(\d+\.\d+\.\d+\.\d+)\.?\s+(.+)/; 

  lines.forEach(line => {
    const str = line.trim();
    if (!str) return;
    
    // Skip headers/footers/table titles
    if (str.includes('Physics 5054') || str.includes('Grade 10-12') || str.includes('TOPIC') || str.includes('CONTENT')) return;

    // 1. DETECT SPECIFIC OUTCOME (Deepest Level - 4 digits)
    const outcomeMatch = str.match(outcomeRegex);
    if (outcomeMatch) {
      if (currentSubtopic) {
        const content = outcomeMatch[2].trim();
        if (curriculum === 'obc') {
          currentSubtopic.specificOutcomes.push(content);
        } else {
          currentSubtopic.competencies.push(content);
        }
      }
      return; 
    }

    // 2. DETECT SUBTOPIC (3 digits)
    const subtopicMatch = str.match(subtopicRegex);
    if (subtopicMatch) {
      if (currentTopic) {
        currentSubtopic = {
          name: subtopicMatch[2].trim(),
          // Initialize arrays (Content fields left empty intentionally)
          competencies: [], scopeOfLessons: [], activities: [], expectedStandards: [],
          specificOutcomes: [], knowledge: [], skills: [], values: []
        };
        currentTopic.subtopics.push(currentSubtopic);
      }
      return;
    }

    // 3. DETECT TOPIC (2 digits)
    const topicMatch = str.match(topicRegex);
    if (topicMatch) {
      currentTopic = {
        name: topicMatch[0].trim(), // Keep the number e.g. "10.1 GENERAL PHYSICS"
        subtopics: []
      };
      topics.push(currentTopic);
      currentSubtopic = null; 
      return;
    }

    // 4. IGNORE EVERYTHING ELSE
    // We intentionally skip Knowledge/Skills/Values text here to avoid confusion.
  });

  if (topics.length > 0) {
    return {
      subject,
      curriculumType: curriculum,
      form: curriculum === 'cbc' ? 'Form 1' : 'Grade 10', 
      topics
    };
  }
  return null;
}

// --- ROUTES ---

app.get('/', (req, res) => res.send('EduGen AI Backend is Running 🚀'));
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'EduGen AI Backend is healthy' }));

// 1. GENERATE DOCUMENT
app.post('/api/generate-document', async (req, res) => {
  try {
    const { prompt } = req.body;
    const content = await callClaude(prompt);
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

// 2. PARSE & SAVE SYLLABUS
app.post('/api/syllabi/parse', upload.single('file'), async (req, res) => {
  try {
    const { curriculum, subject } = req.body;
    const file = req.file;

    if (!file || !curriculum || !subject) {
      return res.status(400).json({ error: 'Missing file, curriculum, or subject' });
    }

    console.log(`📝 Processing file for ${subject} (${curriculum})...`);

    // EXTRACT TEXT
    let fileText = '';
    
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
       const result = await mammoth.extractRawText({ buffer: file.buffer });
       fileText = result.value;
       console.log("✅ Extracted text from Word Doc");
    } 
    else if (file.mimetype === 'application/pdf') {
       const pdfData = await pdf(file.buffer);
       fileText = pdfData.text;
       console.log("✅ Extracted text from PDF");
    } else {
       fileText = file.buffer.toString('utf-8');
    }

    // STEP 1: Use the SKELETON PARSER (Strict Numbering)
    let parsedData = parseZambianSyllabus(fileText, curriculum, subject);

    if (!parsedData) {
      console.log("⚠️ Numbering pattern not found. Falling back to AI...");
      const prompt = `Extract syllabus structure for ${subject}. Return JSON. Text: ${fileText.substring(0, 50000)}`;
      const rawResponse = await callClaude(prompt);
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsedData = JSON.parse(jsonMatch[0]);
    }

    if (!parsedData || !parsedData.topics || parsedData.topics.length === 0) {
      return res.status(400).json({ error: 'Could not extract any topics. Ensure file uses standard numbering (10.1, 10.1.1).' });
    }

    // Save to MongoDB
    const newSyllabus = new Syllabus(parsedData);
    await newSyllabus.save();

    console.log(`✅ Saved ${subject} syllabus with ${parsedData.topics.length} topics.`);
    res.json({ success: true, syllabus: newSyllabus });

  } catch (error) {
    console.error('Parsing/Saving Error:', error);
    res.status(500).json({ error: 'Failed to parse and save syllabus.' });
  }
});

// 3. GET ALL SYLLABI
app.get('/api/syllabi', async (req, res) => {
  try {
    const syllabi = await Syllabus.find().select('subject curriculumType form topics.length updatedAt');
    res.json(syllabi);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch syllabi' });
  }
});

// 4. GET SINGLE SYLLABUS
app.get('/api/syllabi/:id', async (req, res) => {
  try {
    const syllabus = await Syllabus.findById(req.params.id);
    if (!syllabus) return res.status(404).json({ error: 'Syllabus not found' });
    res.json(syllabus);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch syllabus' });
  }
});

// 5. DELETE SYLLABUS
app.delete('/api/syllabi/:id', async (req, res) => {
  try {
    await Syllabus.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Syllabus deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete syllabus' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
