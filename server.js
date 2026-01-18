require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import Model
const Syllabus = require('./models/Syllabus');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for large syllabus texts

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
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20240620', // Using Sonnet for speed/intelligence balance
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

// --- ROUTES ---

// 1. GENERATE DOCUMENT (Existing Endpoint)
app.post('/api/generate-document', async (req, res) => {
  try {
    const { prompt } = req.body;
    const content = await callClaude(prompt);
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

// 2. PARSE & SAVE SYLLABUS (New Endpoint)
app.post('/api/syllabi/parse', async (req, res) => {
  try {
    const { fileContent, curriculum, subject } = req.body;

    if (!fileContent || !curriculum || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`📝 Parsing ${curriculum.toUpperCase()} syllabus for ${subject}...`);

    // Construct Prompt based on Curriculum Type
    let systemPrompt = '';
    if (curriculum === 'cbc') {
      systemPrompt = `
        You are a strict data extraction engine for Zambian CBC Syllabi.
        TASK: Extract syllabus structure from the provided text for ${subject}.
        
        CRITICAL INSTRUCTIONS:
        1. Extract ONLY data explicitly present. Do NOT hallucinate.
        2. Ignore page headers/footers.
        3. Structure: Topic -> Subtopic -> Competencies, Activities, Standards.
        4. 'Scope of Lessons' is usually NOT in the syllabus text. Return it as empty [].
        
        REQUIRED JSON FORMAT:
        {
          "curriculumType": "cbc",
          "subject": "${subject}",
          "form": "Form 1", 
          "topics": [
            {
              "name": "Topic Name",
              "subtopics": [
                {
                  "name": "Subtopic Name",
                  "competencies": ["Competency 1", "Competency 2"],
                  "scopeOfLessons": [],
                  "activities": ["Activity 1"],
                  "expectedStandards": ["Standard 1"],
                  "specificOutcomes": [],
                  "knowledge": [],
                  "skills": [],
                  "values": []
                }
              ]
            }
          ]
        }
      `;
    } else {
      // OBC Prompt
      systemPrompt = `
        You are a strict data extraction engine for Zambian OBC Syllabi.
        TASK: Extract syllabus structure from the provided text for ${subject}.
        
        CRITICAL INSTRUCTIONS:
        1. Extract ONLY data explicitly present. Do NOT hallucinate.
        2. Ignore page headers/footers.
        3. Structure: Topic -> Subtopic -> Specific Outcomes -> Content (Knowledge, Skills, Values).
        
        REQUIRED JSON FORMAT:
        {
          "curriculumType": "obc",
          "subject": "${subject}",
          "form": "Grade 10",
          "topics": [
            {
              "name": "Topic Name",
              "subtopics": [
                {
                  "name": "Subtopic Name",
                  "specificOutcomes": ["Outcome 1", "Outcome 2"],
                  "knowledge": ["Knowledge item"],
                  "skills": ["Skill item"],
                  "values": ["Value item"],
                  "competencies": [],
                  "scopeOfLessons": [],
                  "activities": [],
                  "expectedStandards": []
                }
              ]
            }
          ]
        }
      `;
    }

    const fullPrompt = `${systemPrompt}\n\nSYLLABUS TEXT:\n${fileContent}\n\nReturn ONLY the JSON object.`;

    // Call Claude
    const rawResponse = await callClaude(fullPrompt);

    // Clean JSON (remove markdown blocks if present)
    const cleanJson = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsedData = JSON.parse(cleanJson);

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

// 4. GET SINGLE SYLLABUS (Full Details)
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

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
