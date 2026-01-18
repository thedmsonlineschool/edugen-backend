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

// --- HELPER: ZAMBIAN SYLLABUS SEGMENT PARSER ---
// Strictly counts dot-separated segments to determine hierarchy.
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

  // Regex to capture the number part and the text part
  // e.g. "10.1.1.1 Distinguish..." -> match[1]="10.1.1.1", match[2]="Distinguish..."
  const numberRegex = /^\s*(\d+(?:\.\d+)+)\.?\s+(.+)/;

  lines.forEach(line => {
    const str = line.trim();
    if (!str) return;
    
    // Skip headers/footers/table titles
    if (str.includes('Physics 5054') || str.includes('Grade 10-12') || str.includes('TOPIC') || str.includes('CONTENT')) return;

    const match = str.match(numberRegex);
    
    if (match) {
      const numberPart = match[1]; // e.g. "10.1" or "10.1.1"
      const textPart = match[2].trim(); // e.g. "General Physics"

      // Count segments by splitting by dot
      // "10.1" -> ["10", "1"] -> length 2
      // "10.1.1" -> ["10", "1", "1"] -> length 3
      // "10.1.1.1" -> ["10", "1", "1", "1"] -> length 4
      const segments = numberPart.split('.').length;

      // --- LEVEL 1: TOPIC (2 Segments: 10.1) ---
      if (segments === 2) {
        currentTopic = {
          name: `${numberPart} ${textPart}`, // Keep original number
          subtopics: []
        };
        topics.push(currentTopic);
        currentSubtopic = null; // Reset subtopic
      }

      // --- LEVEL 2: SUBTOPIC (3 Segments: 10.1.1) ---
      else if (segments === 3) {
        if (currentTopic) {
          currentSubtopic = {
            name: `${numberPart} ${textPart}`, // Keep original number
            // Initialize arrays
            competencies: [], scopeOfLessons: [], activities: [], expectedStandards: [],
            specificOutcomes: [], knowledge: [], skills: [], values: []
          };
          currentTopic.subtopics.push(currentSubtopic);
        }
      }

      // --- LEVEL 3: SPECIFIC OUTCOME (4 Segments: 10.1.1.1) ---
      else if (segments === 4) {
        if (currentSubtopic) {
          // Add to correct array based on curriculum
          if (curriculum === 'obc') {
            currentSubtopic.specificOutcomes.push(`${numberPart} ${textPart}`);
          } else {
            currentSubtopic.competencies.push(`${numberPart} ${textPart}`);
          }
        }
      }
    } 
    // --- CONTENT HANDLING (No Number) ---
    else if (currentSubtopic) {
       // If line starts with bullet/dash, treat as content
       if (str.startsWith('•') || str.startsWith('-') || str.startsWith('')) {
          const content = str.replace(/^[•\-\s]+/, '').trim();
          if (content.length > 3) {
             // Simple heuristic for OBC content distribution
             if (curriculum === 'obc') {
                const lower = content.toLowerCase();
                if (lower.startsWith('asking') || lower.startsWith('participating') || lower.startsWith('appreciating')) {
                   currentSubtopic.values.push(content);
                } else if (lower.startsWith('measuring') || lower.startsWith('calculating') || lower.startsWith('comparing')) {
                   currentSubtopic.skills.push(content);
                } else {
                   currentSubtopic.knowledge.push(content);
                }
             }
          }
       }
    }
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

    // STEP 1: Use the SEGMENT PARSER (Strict Counting)
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
