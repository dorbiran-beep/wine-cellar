// Serverless function that proxies requests to Claude API.
// The API key is read from environment variables (set in Vercel dashboard).

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb' // images can be a few MB after base64 encoding
    }
  },
  maxDuration: 60 // allow up to 60 seconds for Claude responses
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ 
      error: 'ANTHROPIC_API_KEY not set. Add it in Vercel: Project Settings → Environment Variables.' 
    });
  }

  try {
    const { messages, max_tokens = 1500, model = 'claude-sonnet-4-20250514' } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, messages })
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error('Claude API error:', response.status, responseText);
      return res.status(response.status).json({ 
        error: `Claude API ${response.status}`,
        details: responseText.substring(0, 500)
      });
    }

    try {
      const data = JSON.parse(responseText);
      return res.status(200).json(data);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Invalid JSON from Claude', raw: responseText.substring(0, 500) });
    }
  } catch (e) {
    console.error('Handler error:', e);
    return res.status(500).json({ error: e.message || 'Unknown server error' });
  }
}
