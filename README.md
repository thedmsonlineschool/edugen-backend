# EduGen AI Backend

Backend server for EduGen AI that handles Claude API calls.

## 🚀 Quick Deploy to Railway

### Step 1: Prepare Files
1. Download this entire `backend-server` folder
2. Create a GitHub repository (or use Railway's direct deployment)

### Step 2: Deploy to Railway

**Option A: Deploy from GitHub (Recommended)**
1. Go to https://railway.app
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your backend repository
5. Railway will auto-detect Node.js and deploy!

**Option B: Deploy from CLI**
1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Initialize: `railway init`
4. Deploy: `railway up`

### Step 3: Add Environment Variable

1. In Railway dashboard, go to your project
2. Click "Variables" tab
3. Add: `CLAUDE_API_KEY` = `your-actual-api-key`
4. Save and redeploy

### Step 4: Get Your Backend URL

Railway will give you a URL like:
`https://edugen-backend-production.up.railway.app`

**Save this URL!** You'll need it for the frontend.

---

## 🧪 Test Your Backend

Once deployed, test it:

```bash
# Health check
curl https://your-railway-url.railway.app/health

# Should return: {"status":"ok","message":"EduGen AI Backend is running"}
```

---

## 💡 Local Development

To run locally:

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env and add your CLAUDE_API_KEY

# Start server
npm start

# Or with auto-reload
npm run dev
```

Server runs on http://localhost:3001

---

## 📋 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_API_KEY` | Yes | Your Anthropic API key |
| `PORT` | No | Server port (Railway sets automatically) |

---

## 🔒 Security Notes

- API key is stored as environment variable (never in code)
- CORS is enabled for frontend communication
- All requests are validated

---

## 📊 API Endpoints

### GET /health
Health check endpoint
- Returns: `{"status":"ok"}`

### POST /api/generate-document
Generate document with Claude AI
- Body: `{"prompt": "your prompt here"}`
- Returns: `{"success": true, "content": "generated content"}`

---

## ⚡ Next Steps

After backend is deployed:
1. Copy your Railway backend URL
2. Update frontend to use this URL
3. Deploy frontend to Vercel
4. Test end-to-end!
