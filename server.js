/**
 * EduGen AI Backend Server
 * Handles Claude API calls for document generation
 */

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'EduGen AI Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Document generation endpoint
app.post('/api/generate-document', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ 
        error: 'Prompt is required' 
      });
    }

    // Get API key from environment variable
    const apiKey = process.env.CLAUDE_API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ 
        error: 'API key not configured on server' 
      });
    }

    console.log('Generating document with Claude API...');

    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Claude API Error:', errorData);
      return res.status(response.status).json({ 
        error: 'Claude API request failed',
        details: errorData 
      });
    }

    const data = await response.json();

    // Extract text from response
    const content = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');

    console.log('Document generated successfully');

    res.json({ 
      success: true,
      content: content,
      usage: data.usage
    });

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({ 
    error: 'Something went wrong',
    message: err.message 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ EduGen AI Backend running on port ${PORT}`);
  console.log(`📄 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 API endpoint: http://localhost:${PORT}/api/generate-document`);
});
