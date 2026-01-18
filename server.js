require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer'); // For file uploads
const pdf = require('pdf-parse'); // For extracting text from PDF
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import Model
const Syllabus = require('./models/Syllabus');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configure Multer (Memory Storage for immediate parsing)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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

// --- HELPER: ROBUST LOCAL PARSER (Improved for PDF Text) ---
function parseSyllabusLocally(text, curriculum, subject) {
  const lines = text.split('\n');
  const topics = [];
  let currentTopic = null;
  let currentSubtopic = null;

  // Improved Regex: Allows whitespace at start (^\s*)
  const topicRegex = /^\s*(\d+\.\d+)\s+(.+)/;       
  const subtopicRegex = /^\s*(\d+\.\d+\.\d+)\s+(.+)/; 
  const outcomeRegex = /^\s*(\d+\.\d+\.\d+\.\d+)\s+(.+)/; 

  lines.forEach(line => {
    const cleanLine = line.trim();
    if (!cleanLine) return;
    
    // Ignore Page Headers/Footers common in PDFs
    if (cleanLine.includes('Physics 5054') || cleanLine.match(/^Grade \d+-\d+/)) return;

    // 1. Check for Specific Outcome (Deepest Level)
    const outcomeMatch = cleanLine.match(outcomeRegex);
    if (outcomeMatch && currentSubtopic) {
      const outcomeText = outcomeMatch[2].trim();
      if (curriculum === 'obc') {
        currentSubtopic.specificOutcomes.push(outcomeText);
      } else {
        currentSubtopic.competencies.push(outcomeText);
      }
      return;
    }

    // 2. Check for Subtopic
    const subtopicMatch = cleanLine.match(subtopicRegex);
    if (subtopicMatch && currentTopic) {
      currentSubtopic = {
        name: subtopicMatch[2].trim(),
        competencies: [], scopeOfLessons: [], activities: [], expectedStandards: [],
        specificOutcomes: [], knowledge: [], skills: [], values: []
      };
      currentTopic.subtopics.push(currentSubtopic);
      return;
    }

    // 3. Check for Topic
    const topicMatch = cleanLine.match(topicRegex);
    if (topicMatch) {
      currentTopic = {
        name: topicMatch[2].trim(),
        subtopics: []
      };
      topics.push(currentTopic);
      currentSubtopic = null;
      return;
    }

    // 4. Content Fallback (Knowledge/Skills/Values)
    // Capture bullet points, dashes, or lines that look like content
    if (currentSubtopic && (cleanLine.startsWith('•') || cleanLine.startsWith('-') || cleanLine.startsWith('') || cleanLine.length > 5)) {
       const contentText = cleanLine.replace(/^[•\-\s]+/, '').trim();
       // Filter out garbage short lines
       if (contentText.length < 3) return;

       if (curriculum === 'obc') {
           // Simple heuristic: distribute content to knowledge for now
           currentSubtopic.knowledge.push(contentText);
       } else {
           currentSubtopic.scopeOfLessons.push(contentText);
       }
    }
  });

  if (topics.length > 0) {
    return {
      subject,
      curriculumType: curriculum,
      form: curriculum === 'cbc' ? 'Form 1' : 'Grade 10', // Default
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

// 2. PARSE & SAVE SYLLABUS (FILE UPLOAD SUPPORT)
app.post('/api/syllabi/parse', upload.single('file'), async (req, res) => {
  try {
    const { curriculum, subject } = req.body;
    const file = req.file;

    if (!file || !curriculum || !subject) {
      return res.status(400).json({ error: 'Missing file, curriculum, or subject' });
    }

    console.log(`📝 Processing file for ${subject} (${curriculum})...`);

    // EXTRACT TEXT FROM PDF
    let fileText = '';
    if (file.mimetype === 'application/pdf') {
      const pdfData = await pdf(file.buffer);
      fileText = pdfData.text;
    } else {
      // Assume text/plain for now
      fileText = file.buffer.toString('utf-8');
    }

    // STEP 1: Try Local Regex Parsing first
    const localData = parseSyllabusLocally(fileText, curriculum, subject);
    
    let parsedData = null;

    if (localData) {
      console.log("✅ Local Regex Parsing Successful!");
      parsedData = localData;
    } else {
      console.log("⚠️ Local parsing failed. Falling back to Claude AI...");
      
      // STEP 2: Fallback to Claude AI
      let systemPrompt = '';
      if (curriculum === 'cbc') {
        systemPrompt = `
          You are a strict data extraction engine for Zambian CBC Syllabi.
          TASK: Extract syllabus structure from the provided text for ${subject}.
          CRITICAL: Extract ONLY data explicitly present. Return JSON format.
          Structure: Topic -> Subtopic -> Competencies, Activities, Standards.
        `;
      } else {
        systemPrompt = `
          You are a strict data extraction engine for Zambian OBC Syllabi.
          TASK: Extract syllabus structure from the provided text for ${subject}.
          CRITICAL: Extract ONLY data explicitly present. Return JSON format.
          Structure: Topic -> Subtopic -> Specific Outcomes -> Content.
        `;
      }

      const fullPrompt = `${systemPrompt}\n\nSYLLABUS TEXT:\n${fileText.substring(0, 100000)}\n\nReturn ONLY the JSON object.`;
      const rawResponse = await callClaude(fullPrompt);
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");
      parsedData = JSON.parse(jsonMatch[0]);
    }

    // Save to MongoDB
    const newSyllabus = new Syllabus(parsedData);
    await newSyllabus.save();

    console.log(`✅ Saved ${subject} syllabus to DB.`);
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
