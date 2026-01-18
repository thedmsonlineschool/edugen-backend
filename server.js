require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
// Dynamic import for node-fetch (required for v3+)
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import Model
const Syllabus = require('./models/Syllabus');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
// Increased limit to 10mb to handle large syllabus text pastes
app.use(express.json({ limit: '10mb' })); 

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
        // ✅ FIXED: Using CLAUDE_API_KEY to match your Railway variables
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
    
    if (!response.ok) {
      console.error("Claude API Error Details:", data);
      throw new Error(data.error?.message || 'Claude API Error');
    }
    
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

// 2. PARSE & SAVE SYLLABUS (New Endpoint for Phase 6A)
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
                  "specificOutcome
