// Serverless function that proxies requests to Claude API.
// Supports an optional `useWebSearch` flag to enable Claude's native web_search tool,
// which lets Claude look up real wine data from Wine-Searcher and other sources.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4.5mb'
    }
  }
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
    const {
      messages,
      max_tokens = 1500,
      model = 'claude-sonnet-4-5',
      useWebSearch = false,
      maxSearches = 3
    } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const body = { model, max_tokens, messages };

    // Enable native web search for wine lookups
    if (useWebSearch) {
      body.tools = [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxSearches,
        allowed_domains: [
          'wine-searcher.com',
          'www.wine-searcher.com',
          'vivino.com',
          'www.vivino.com',
          'winemag.com',
          'www.winemag.com',
          'decanter.com',
          'www.decanter.com',
          'jancisrobinson.com',
          'www.jancisrobinson.com',
          'wine.com',
          'www.wine.com',
          'klwines.com',
          'www.klwines.com',
          'jamessuckling.com',
          'www.jamessuckling.com'
        ]
      }];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
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
