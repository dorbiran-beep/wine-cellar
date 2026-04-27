import React, { useState, useEffect, useRef } from 'react';
import { Wine, Plus, Search, Camera, Download, Star, MapPin, Sparkles, TrendingUp, Clock, ChefHat, X, Receipt, Edit3, Trash2, Award, Droplet, ThermometerSun, Loader2, Table, Check, AlertCircle, Upload, Grape } from 'lucide-react';

export default function App() {
  const [wines, setWines] = useState([]);
  const [view, setView] = useState('cellar');
  const [selectedWine, setSelectedWine] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('added');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [addMode, setAddMode] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [unrecognizedImage, setUnrecognizedImage] = useState(null);
  const [wineToReidentify, setWineToReidentify] = useState(null);
  const [wineToReenrich, setWineToReenrich] = useState(null);
  const [mergeToast, setMergeToast] = useState(null); // { mergedNames: [...], onUndo: fn }

  useEffect(() => {
    try {
      const stored = localStorage.getItem('wine-cellar');
      if (stored) setWines(JSON.parse(stored));
    } catch (e) {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem('wine-cellar', JSON.stringify(wines));
    } catch (e) { console.error('Save failed', e); }
  }, [wines, loaded]);

  const [debugInfo, setDebugInfo] = useState(null);

  const callClaude = async (messages, maxTokens = 1500, options = {}) => {
    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          max_tokens: maxTokens,
          useWebSearch: options.useWebSearch || false,
          maxSearches: options.maxSearches || 3
        })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.substring(0, 300)}`);
      }
      const data = await response.json();
      if (data.error) {
        throw new Error(`API error: ${JSON.stringify(data.error).substring(0, 300)}`);
      }
      if (!data.content) {
        throw new Error(`No content in response`);
      }
      // Extract text from all content blocks (ignore tool_use / web_search_tool_result blocks)
      return data.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    } catch (e) {
      throw new Error('שגיאת רשת: ' + e.message);
    }
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Resize and heavily compress images to stay well under Vercel Hobby plan's 4.5MB request body limit
  const processImageForAPI = (file) => new Promise((resolve, reject) => {
    const MAX_DIM = 1280; // smaller for safer upload size
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        
        // Try progressively lower quality until under 2MB
        let quality = 0.82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 2_800_000 && quality > 0.4) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        console.log('Image compressed to', Math.round(dataUrl.length / 1024), 'KB at quality', quality.toFixed(2));
        resolve({ data: dataUrl.split(',')[1], media_type: 'image/jpeg' });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // ───── Duplicate detection & merging ─────
  // Normalize a string for comparison: lowercase, collapse whitespace, strip punctuation
  const normalize = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\u0590-\u05FF]+/g, ' ').trim();

  // Find an existing wine in the cellar that matches a candidate (same name+producer+vintage)
  const findDuplicate = (candidate, existingWines) => {
    if (!candidate.name) return null;
    const candName = normalize(candidate.name);
    const candProducer = normalize(candidate.producer);
    const candVintage = candidate.vintage ? parseInt(candidate.vintage) : null;
    return existingWines.find(w => {
      const wName = normalize(w.name);
      const wProducer = normalize(w.producer);
      const wVintage = w.vintage ? parseInt(w.vintage) : null;
      // Vintage must match (both null OR equal)
      if (candVintage !== wVintage) return false;
      // Name must match closely - exact match or one contains the other
      const namesMatch = wName === candName || (wName.length > 8 && candName.length > 8 && (wName.includes(candName) || candName.includes(wName)));
      if (!namesMatch) return false;
      // If both have producers, they should match too
      if (candProducer && wProducer && candProducer !== wProducer && !candProducer.includes(wProducer) && !wProducer.includes(candProducer)) return false;
      return true;
    });
  };

  // Add a wine, but merge with an existing one if it's a duplicate.
  // Returns { wine, wasMerged }
  const addOrMergeWine = (newWine, existingWines) => {
    const dup = findDuplicate(newWine, existingWines);
    if (!dup) {
      return { wine: newWine, wasMerged: false, mergedInto: null };
    }
    // Merge: add quantity, keep richer data, prefer existing label image unless new one is provided and old one isn't
    const addedQty = newWine.quantity || 1;
    const merged = {
      ...dup,
      quantity: (dup.quantity || 1) + addedQty,
      // Keep the label image - prefer existing, but use new if missing
      labelImage: dup.labelImage || newWine.labelImage,
      // Prefer new enrichment fields if they exist and old ones don't
      criticScore: dup.criticScore || newWine.criticScore,
      criticNotes: dup.criticNotes || newWine.criticNotes,
      drinkFrom: dup.drinkFrom || newWine.drinkFrom,
      drinkBy: dup.drinkBy || newWine.drinkBy,
      peakYear: dup.peakYear || newWine.peakYear,
      tastingNotes: dup.tastingNotes || newWine.tastingNotes,
      foodPairings: dup.foodPairings && dup.foodPairings.length ? dup.foodPairings : newWine.foodPairings,
      servingTemp: dup.servingTemp || newWine.servingTemp,
      decant: dup.decant !== undefined ? dup.decant : newWine.decant,
      grape: dup.grape || newWine.grape,
      region: dup.region || newWine.region,
      // Track purchase history for price differences
      purchaseHistory: [
        ...(dup.purchaseHistory || (dup.price ? [{ price: dup.price, currency: dup.currency, quantity: dup.quantity || 1, date: dup.addedAt }] : [])),
        { price: newWine.price, currency: newWine.currency, quantity: addedQty, date: new Date().toISOString() }
      ].filter(h => h.price)
    };
    return { wine: merged, wasMerged: true, mergedInto: dup };
  };

  // Process a batch of new wines, merging duplicates into existing ones.
  // Returns the updated full wines list, AND info about what was merged.
  const mergeWinesIntoCellar = (newWines, existingWines) => {
    const finalWines = [...existingWines];
    const merged = []; // { newName, intoName, addedQty }
    const trulyNew = [];

    for (const nw of newWines) {
      const dup = findDuplicate(nw, finalWines);
      if (dup) {
        const result = addOrMergeWine(nw, finalWines);
        const idx = finalWines.findIndex(w => w.id === dup.id);
        finalWines[idx] = result.wine;
        merged.push({ name: nw.name, vintage: nw.vintage, addedQty: nw.quantity || 1, totalQty: result.wine.quantity });
      } else {
        finalWines.unshift(nw); // new at top
        trulyNew.push(nw);
      }
    }

    return { wines: finalWines, merged, trulyNew };
  };

  // Show merge toast if anything was merged
  const showMergeToastIfNeeded = (merged) => {
    if (merged.length > 0) {
      setMergeToast({ items: merged });
      setTimeout(() => setMergeToast(null), 5000);
    }
  };

  const enrichWine = async (wine, hints) => {
    const hintsText = hints && hints.trim() ? `\n\nADDITIONAL HINTS from the user (use these to refine the search):\n${hints.trim()}\n` : '';

    const buildPrompt = (useSearch) => useSearch
      ? `I need detailed, ACCURATE information about this specific wine:
Wine: ${wine.name}
${wine.producer ? `Producer: ${wine.producer}` : ''}
${wine.vintage ? `Vintage: ${wine.vintage}` : ''}
${wine.region ? `Region: ${wine.region}` : ''}
${wine.grape ? `Grape: ${wine.grape}` : ''}${hintsText}

Search Wine-Searcher.com, CellarTracker, Vivino, Decanter, Wine Enthusiast, Vinous, James Suckling and similar reputable wine sites to find REAL, FACTUAL information. Do NOT guess or invent details.

For boutique/natural/lesser-known wines, also try searching for the producer's website directly, or for the specific cuvée name. Search in multiple ways if needed.

Based on the real data you find, return ONLY valid JSON (no markdown):
{
  "correctedName": "authoritative full wine name if yours differs",
  "correctedProducer": "correct producer name",
  "correctedType": "red/white/rose/sparkling/dessert/fortified - VERIFY this from the search",
  "correctedGrape": "actual grape variety/varieties",
  "correctedRegion": "actual region and country",
  "correctedVintage": vintage as number if clearer from search,
  "criticScore": numeric score 80-100 based on actual aggregate or critic scores found,
  "criticNotes": "brief critic notes in Hebrew based on real reviews found (2-3 sentences)",
  "drinkFrom": year,
  "drinkBy": year,
  "peakYear": year,
  "tastingNotes": "real tasting notes in Hebrew based on search results (3-4 sentences)",
  "foodPairings": ["dish1 in Hebrew","dish2","dish3","dish4"],
  "servingTemp": "serving temp in Celsius",
  "decant": true/false,
  "marketValue": current average retail price per bottle in USD (number, no currency symbol),
  "marketValueCurrency": "USD",
  "_searchSucceeded": true if you found real data, false if you couldn't find this specific wine
}

CRITICAL:
- The type (red/white/rose/etc) MUST match reality. Many natural and lesser-known wines are easily misclassified.
- If search finds the wine is different from what user said, use the "corrected*" fields.
- Set "_searchSucceeded" to false if you couldn't find real info about this specific wine.
- For marketValue: use the Wine-Searcher aggregate average price for the SPECIFIC vintage if available, otherwise the average across vintages. Number only, in USD.
- Only include fields where you have actual data. Omit fields where you're uncertain.`
      : `You are a wine expert. Based on your knowledge, provide information about this wine:
Wine: ${wine.name}
${wine.producer ? `Producer: ${wine.producer}` : ''}
${wine.vintage ? `Vintage: ${wine.vintage}` : ''}${hintsText}

Return ONLY valid JSON (no markdown):
{
  "correctedType": "red/white/rose/sparkling/dessert/fortified if you know it",
  "correctedGrape": "grape if you know it",
  "correctedRegion": "region if you know it",
  "criticScore": 80-100,
  "criticNotes": "critic notes in Hebrew (2-3 sentences)",
  "drinkFrom": year,
  "drinkBy": year,
  "peakYear": year,
  "tastingNotes": "tasting notes in Hebrew (3-4 sentences)",
  "foodPairings": ["dish1 in Hebrew","dish2","dish3","dish4"],
  "servingTemp": "serving temp in Celsius",
  "decant": true/false,
  "marketValue": null,
  "_searchSucceeded": false
}

Only include fields you're confident about. Leave marketValue as null (we can't estimate prices without web search).`;

    const runEnrich = async (useSearch) => {
      const result = await callClaude([{ role: 'user', content: buildPrompt(useSearch) }], 1500, useSearch ? { useWebSearch: true, maxSearches: hints ? 4 : 3 } : {});
      let cleaned = result.replace(/```json\n?|```/g, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      if (!cleaned) throw new Error('empty response');
      return JSON.parse(cleaned);
    };

    try {
      let parsed;
      try {
        parsed = await runEnrich(true);
      } catch (webErr) {
        console.warn('Web-search enrichment failed, falling back', webErr);
        parsed = await runEnrich(false);
      }

      // Apply corrections if the search found better info
      const corrected = {};
      if (parsed.correctedName) corrected.name = parsed.correctedName;
      if (parsed.correctedProducer) corrected.producer = parsed.correctedProducer;
      if (parsed.correctedType) corrected.type = parsed.correctedType;
      if (parsed.correctedGrape) corrected.grape = parsed.correctedGrape;
      if (parsed.correctedRegion) corrected.region = parsed.correctedRegion;
      if (parsed.correctedVintage) corrected.vintage = parsed.correctedVintage;

      const { correctedName, correctedProducer, correctedType, correctedGrape, correctedRegion, correctedVintage, ...enrichment } = parsed;
      return { ...corrected, ...enrichment };
    } catch (e) {
      console.warn('Enrichment error:', e);
      return { _searchSucceeded: false };
    }
  };

  // Re-enrich an existing wine with optional user hints (e.g. "this is a natural orange wine, Sangiovese grape")
  const reenrichWineWithHints = async (wineId, hints) => {
    const wine = wines.find(w => w.id === wineId);
    if (!wine) return;
    setWineToReenrich(null);
    setWines(prev => prev.map(w => w.id === wineId ? { ...w, _enriching: true } : w));
    if (selectedWine?.id === wineId) setSelectedWine(p => ({ ...p, _enriching: true }));

    const extra = await enrichWine(wine, hints);
    const updated = { ...wine, ...extra, _enriching: false };
    setWines(prev => prev.map(w => w.id === wineId ? updated : w));
    if (selectedWine?.id === wineId) setSelectedWine(updated);
  };

  const analyzeWineImage = async (files, mode) => {
    setIsAnalyzing(true);
    setDebugInfo(null);
    setAnalysisStatus(mode === 'invoice' ? 'קורא את החשבונית...' : 'מזהה את הבקבוקים...');
    try {
      // Process images and keep both the small API version and a display version
      const processedImages = await Promise.all(Array.from(files).map(async (file) => {
        const processed = await processImageForAPI(file);
        return {
          apiSource: { type: 'base64', media_type: processed.media_type, data: processed.data },
          displayDataUrl: 'data:image/jpeg;base64,' + processed.data
        };
      }));
      const imageContents = processedImages.map(p => ({ type: 'image', source: p.apiSource }));

      const prompt = mode === 'invoice'
        ? `This is a wine purchase invoice (may be in Hebrew, English, or another language). Your job is to extract EVERY wine listed in the invoice table.

For each row in the invoice that represents a wine product:
- Extract the wine name, vintage year (look for a 4-digit year in the name), producer, quantity, and price per bottle
- The vintage year is often part of the wine name (e.g., "Fenocchio Barolo 2018" - vintage is 2018)
- Quantity is usually in a "כמות" or "Qty" column
- Unit price is usually in a "מחיר" or "Price" column (not the total)
- Use your knowledge to determine the wine type, grape, and region based on the name

Return ONLY valid JSON in this exact format (no markdown, no comments, no trailing commas):
{"wines":[{"name":"Wine Name","producer":"Producer","vintage":2018,"type":"red","grape":"Nebbiolo","region":"Piedmont, Italy","quantity":2,"price":148.31,"currency":"ILS","confidence":"high"}]}

type must be one of: red, white, rose, sparkling, dessert, fortified
confidence must be: "high" (clearly read), "medium" (partial info), or "low" (guessing).
If invoice is in Israeli shekels use currency "ILS".
Extract ALL wines in the invoice, not just some.`
        : `This is a photo of wine bottle(s). Identify each bottle visible.

IMPORTANT rules:
- Only identify wines you can actually read from the label or recognize with high confidence
- If the label is blurry, occluded, or you can't read the wine name clearly — return confidence:"low" and include any text you CAN see (even partial) in "partialText"
- Never invent a wine name. If unsure, say so with low confidence.
- If you recognize the producer/winery but not the specific wine name, still return it with medium confidence

Return ONLY valid JSON (no markdown):
{"wines":[{"name":"Wine Name","producer":"Producer","vintage":2020,"type":"red","grape":"Cabernet Sauvignon","region":"Region, Country","quantity":1,"alcohol":14.5,"description":"תיאור קצר בעברית","confidence":"high","partialText":"any text you can read from the label, even if you cant identify the wine"}]}

type must be one of: red, white, rose, sparkling, dessert, fortified.
confidence must be: "high", "medium", or "low".
If you cannot identify any wine at all, return {"wines":[],"noRecognition":true,"partialText":"any text visible on the label"}.`;

      const result = await callClaude([{ role: 'user', content: [...imageContents, { type: 'text', text: prompt }] }], 2000);
      console.log('Raw AI response:', result);

      let cleaned = result.replace(/```json\n?|```/g, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error('JSON parse error:', parseErr, 'Content:', cleaned);
        throw new Error('לא הצלחתי לפענח את התוצאה. נסה תמונה ברורה יותר.');
      }

      // Handle the "no recognition" case
      if (parsed.noRecognition || !parsed.wines || parsed.wines.length === 0) {
        setIsAnalyzing(false);
        setUnrecognizedImage({
          dataUrl: processedImages[0]?.displayDataUrl,
          partialText: parsed.partialText || ''
        });
        return;
      }

      // Check if any wine has low confidence - show picker for that too
      const hasLowConfidence = mode === 'photo' && parsed.wines.some(w => w.confidence === 'low');
      if (hasLowConfidence && parsed.wines.length === 1) {
        setIsAnalyzing(false);
        setUnrecognizedImage({
          dataUrl: processedImages[0]?.displayDataUrl,
          partialText: parsed.wines[0].partialText || parsed.wines[0].name || '',
          uncertainWine: parsed.wines[0]
        });
        return;
      }

      // Add wines immediately with the photo attached
      const candidateWines = parsed.wines.map((w, i) => ({
        ...w,
        id: Date.now() + Math.random() + i,
        addedAt: new Date().toISOString(),
        quantity: w.quantity || 1,
        labelImage: mode === 'photo' ? processedImages[Math.min(i, processedImages.length - 1)]?.displayDataUrl : null,
        _enriching: true
      }));
      // Merge duplicates with existing wines
      let mergeResult;
      setWines(prev => {
        mergeResult = mergeWinesIntoCellar(candidateWines, prev);
        return mergeResult.wines;
      });
      // Wait one tick for state to settle, then show toast
      setTimeout(() => {
        if (mergeResult) showMergeToastIfNeeded(mergeResult.merged);
      }, 100);
      setIsAnalyzing(false);
      setAddMode(null);
      setShowAddMenu(false);

      // Enrich in background — only for truly new wines (merged ones already have data)
      const winesToEnrich = mergeResult ? mergeResult.trulyNew : candidateWines;
      for (const wine of winesToEnrich) {
        try {
          const extra = await enrichWine(wine);
          setWines(prev => prev.map(w => w.id === wine.id ? { ...w, ...extra, _enriching: false } : w));
        } catch (e) {
          console.warn('Enrichment failed for', wine.name, e);
          setWines(prev => prev.map(w => w.id === wine.id ? { ...w, _enriching: false } : w));
        }
      }
    } catch (e) {
      console.error('Analyze error:', e);
      setDebugInfo({ stage: 'analyze', message: e.message, stack: e.stack });
      setAnalysisStatus(e.message || 'שגיאה. נסה שוב.');
      setTimeout(() => setIsAnalyzing(false), 8000);
    }
  };

  const addWineManually = async (wineData) => {
    setIsAnalyzing(true);
    setAnalysisStatus('מעשיר במידע...');
    const extra = await enrichWine(wineData);
    const newWine = { ...wineData, ...extra, id: Date.now() + Math.random(), addedAt: new Date().toISOString() };
    let mergeResult;
    setWines(prev => {
      mergeResult = mergeWinesIntoCellar([newWine], prev);
      return mergeResult.wines;
    });
    setTimeout(() => {
      if (mergeResult) showMergeToastIfNeeded(mergeResult.merged);
    }, 100);
    setIsAnalyzing(false);
    setAddMode(null);
    setShowAddMenu(false);
  };

  // User confirmed a chosen wine from the "help identify" flow
  const confirmIdentifiedWine = async (wineData, labelImage) => {
    setUnrecognizedImage(null);
    const newWine = {
      ...wineData,
      id: Date.now() + Math.random(),
      addedAt: new Date().toISOString(),
      quantity: wineData.quantity || 1,
      labelImage,
      _enriching: true
    };
    let mergeResult;
    setWines(prev => {
      mergeResult = mergeWinesIntoCellar([newWine], prev);
      return mergeResult.wines;
    });
    setTimeout(() => {
      if (mergeResult) showMergeToastIfNeeded(mergeResult.merged);
    }, 100);
    setAddMode(null);
    setShowAddMenu(false);

    // Only enrich if this is a truly new wine (wasn't merged into existing)
    const wasMerged = mergeResult && mergeResult.merged.length > 0;
    if (!wasMerged) {
      try {
        const extra = await enrichWine(newWine);
        setWines(prev => prev.map(w => w.id === newWine.id ? { ...w, ...extra, _enriching: false } : w));
      } catch (e) {
        setWines(prev => prev.map(w => w.id === newWine.id ? { ...w, _enriching: false } : w));
      }
    }
  };

  // User picks a replacement wine to replace one that was misidentified
  const replaceWine = async (oldWineId, newWineData) => {
    setWineToReidentify(null);
    const labelImage = wines.find(w => w.id === oldWineId)?.labelImage;
    const replacement = {
      ...newWineData,
      id: oldWineId,
      addedAt: new Date().toISOString(),
      quantity: newWineData.quantity || 1,
      labelImage,
      _enriching: true
    };
    setWines(prev => prev.map(w => w.id === oldWineId ? replacement : w));
    if (selectedWine?.id === oldWineId) setSelectedWine(replacement);

    try {
      const extra = await enrichWine(replacement);
      const enriched = { ...replacement, ...extra, _enriching: false };
      setWines(prev => prev.map(w => w.id === oldWineId ? enriched : w));
      if (selectedWine?.id === oldWineId) setSelectedWine(enriched);
    } catch (e) {
      setWines(prev => prev.map(w => w.id === oldWineId ? { ...replacement, _enriching: false } : w));
    }
  };

  const importFromTable = async (rows, shouldEnrich) => {
    setIsAnalyzing(true);
    setAnalysisStatus('מוסיף ' + rows.length + ' יינות...');
    const newWines = [];
    for (let i = 0; i < rows.length; i++) {
      const w = rows[i];
      let extra = {};
      if (shouldEnrich) {
        setAnalysisStatus('מעשיר ' + (i+1) + '/' + rows.length + ': ' + w.name);
        extra = await enrichWine(w);
      }
      newWines.push({ ...w, ...extra, id: Date.now() + Math.random() + i, addedAt: new Date().toISOString() });
    }
    let mergeResult;
    setWines(prev => {
      mergeResult = mergeWinesIntoCellar(newWines, prev);
      return mergeResult.wines;
    });
    setTimeout(() => {
      if (mergeResult) showMergeToastIfNeeded(mergeResult.merged);
    }, 100);
    setIsAnalyzing(false);
    setAddMode(null);
    setShowAddMenu(false);
  };

  const updateQuantity = (id, delta) => {
    setWines(prev => prev.map(w => w.id === id ? { ...w, quantity: Math.max(0, (w.quantity || 1) + delta) } : w).filter(w => w.quantity > 0));
  };

  const updateWineFields = (id, fields) => {
    setWines(prev => prev.map(w => w.id === id ? { ...w, ...fields } : w));
    if (selectedWine?.id === id) setSelectedWine(p => ({ ...p, ...fields }));
  };

  const deleteWine = (id) => {
    setWines(prev => prev.filter(w => w.id !== id));
    setSelectedWine(null);
  };

  const translateType = (type) => {
    const map = { red: 'אדום', white: 'לבן', rose: 'רוזה', 'rosé': 'רוזה', sparkling: 'מבעבע', dessert: 'קינוח', fortified: 'מחוזק' };
    return map[type?.toLowerCase()] || type;
  };

  const getWineColor = (type) => {
    const t = type?.toLowerCase();
    if (t === 'red') return { bg: 'from-[#5c1a1b] to-[#2a0a0b]', accent: '#8b2635' };
    if (t === 'white') return { bg: 'from-[#d4c080] to-[#8a7a3e]', accent: '#b89d4f' };
    if (t === 'rose' || t === 'rosé') return { bg: 'from-[#e8a5a5] to-[#b56666]', accent: '#d47979' };
    if (t === 'sparkling') return { bg: 'from-[#f0e0a8] to-[#b8a060]', accent: '#d4bc6a' };
    return { bg: 'from-[#7a4a20] to-[#3a2010]', accent: '#a06830' };
  };

  const exportToExcel = () => {
    const headers = ['שם','יקב','ענבים','בציר','סוג','אזור','כמות','ציון','שתייה מ','שתייה עד','מחיר'];
    const rows = wines.map(w => [
      w.name || '', w.producer || '', w.grape || '', w.vintage || '',
      translateType(w.type) || '', w.region || '', w.quantity || 1,
      w.criticScore || '', w.drinkFrom || '', w.drinkBy || '',
      w.price ? w.price + ' ' + (w.currency || '') : ''
    ]);
    const csv = '\ufeff' + [headers, ...rows].map(r => r.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wine-cellar-' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentYear = new Date().getFullYear();
  const getDrinkStatus = (wine) => {
    if (!wine.drinkFrom && !wine.drinkBy) return null;
    if (wine.drinkFrom && currentYear < wine.drinkFrom) return { status: 'young', label: 'צעיר מדי', color: '#8b9dc3' };
    if (wine.drinkBy && currentYear > wine.drinkBy) return { status: 'past', label: 'מעבר לשיא', color: '#a0a0a0' };
    if (wine.peakYear && Math.abs(currentYear - wine.peakYear) <= 1) return { status: 'peak', label: 'בשיאו', color: '#d4a574' };
    return { status: 'ready', label: 'מוכן לשתייה', color: '#7ba87b' };
  };

  const filteredWines = wines
    .filter(w => {
      if (filterType !== 'all' && w.type?.toLowerCase() !== filterType) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (w.name?.toLowerCase().includes(q) || w.producer?.toLowerCase().includes(q) || w.region?.toLowerCase().includes(q) || w.grape?.toLowerCase().includes(q));
    })
    .sort((a,b) => {
      if (sortBy === 'added') return new Date(b.addedAt) - new Date(a.addedAt);
      if (sortBy === 'score') return (b.criticScore||0) - (a.criticScore||0);
      if (sortBy === 'vintage') return (b.vintage||0) - (a.vintage||0);
      if (sortBy === 'name') return (a.name||'').localeCompare(b.name||'');
      return 0;
    });

  const totalBottles = wines.reduce((sum, w) => sum + (w.quantity || 1), 0);

  return (
    <div dir="rtl" className="min-h-screen relative" style={{
      background: 'linear-gradient(180deg, #fafaf7 0%, #f4efe8 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif'
    }}>
      <div className="fixed inset-0 pointer-events-none opacity-40" style={{
        background: 'radial-gradient(ellipse at top right, rgba(139, 38, 53, 0.08), transparent 50%), radial-gradient(ellipse at bottom left, rgba(212, 165, 116, 0.1), transparent 50%)'
      }} />

      <header className="sticky top-0 z-40 backdrop-blur-2xl border-b border-black/5" style={{ background: 'rgba(250, 250, 247, 0.72)' }}>
        <div className="max-w-6xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/icon-180.png" alt="מרתף היין" className="w-9 h-9 rounded-[10px]" style={{
              boxShadow: '0 2px 8px rgba(92, 26, 27, 0.3)'
            }} />
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight" style={{ color: '#1d1d1f' }}>המרתף שלי</h1>
              <p className="text-[11px] text-gray-500 -mt-0.5">{totalBottles} בקבוקים · {wines.length} תוויות</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportToExcel} disabled={!wines.length} className="w-9 h-9 rounded-full bg-white/60 hover:bg-white border border-black/5 flex items-center justify-center transition-all active:scale-95 disabled:opacity-30" title="ייצוא">
              <Download className="w-4 h-4" style={{ color: '#5c1a1b' }} strokeWidth={2} />
            </button>
            <button onClick={() => setShowAddMenu(true)} className="h-9 px-4 rounded-full flex items-center gap-1.5 text-white text-[13px] font-medium transition-all active:scale-95" style={{
              background: 'linear-gradient(135deg, #5c1a1b, #3a1011)',
              boxShadow: '0 2px 10px rgba(92, 26, 27, 0.35)'
            }}>
              <Plus className="w-4 h-4" strokeWidth={2.5} />
              הוסף
            </button>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-5 pb-3 flex gap-1">
          {[{ id: 'cellar', label: 'המרתף', icon: Wine }, { id: 'recommendations', label: 'מה לשתות', icon: Sparkles }, { id: 'stats', label: 'תובנות', icon: TrendingUp }].map(tab => {
            const Icon = tab.icon;
            const active = view === tab.id;
            return (
              <button key={tab.id} onClick={() => { setView(tab.id); setSelectedWine(null); }} className={"h-8 px-3.5 rounded-full text-[13px] font-medium transition-all flex items-center gap-1.5 " + (active ? 'text-white' : 'text-gray-600 hover:bg-black/5')} style={active ? { background: '#1d1d1f' } : {}}>
                <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 relative">
        {selectedWine ? (
          <WineDetail wine={selectedWine} onBack={() => setSelectedWine(null)} onDelete={() => deleteWine(selectedWine.id)} onUpdateQuantity={(d) => { updateQuantity(selectedWine.id, d); setSelectedWine(p => ({ ...p, quantity: Math.max(0, (p.quantity||1)+d) })); }} onReidentify={() => setWineToReidentify(selectedWine)} onReenrich={() => setWineToReenrich(selectedWine)} onUpdateFields={(fields) => updateWineFields(selectedWine.id, fields)} getDrinkStatus={getDrinkStatus} getWineColor={getWineColor} translateType={translateType} />
        ) : view === 'cellar' ? (
          <CellarView wines={filteredWines} allWines={wines} searchQuery={searchQuery} setSearchQuery={setSearchQuery} filterType={filterType} setFilterType={setFilterType} sortBy={sortBy} setSortBy={setSortBy} onSelectWine={setSelectedWine} getDrinkStatus={getDrinkStatus} getWineColor={getWineColor} translateType={translateType} onOpenAdd={() => setShowAddMenu(true)} />
        ) : view === 'recommendations' ? (
          <RecommendationsView allWines={wines} onSelectWine={setSelectedWine} getWineColor={getWineColor} translateType={translateType} callClaude={callClaude} getDrinkStatus={getDrinkStatus} />
        ) : (
          <StatsView wines={wines} totalBottles={totalBottles} translateType={translateType} />
        )}
      </main>

      {showAddMenu && !addMode && (
        <Modal onClose={() => setShowAddMenu(false)} title="הוסף יין">
          <div className="space-y-2.5">
            <AddOption icon={Edit3} title="הוספה ידנית" desc="הקלד פרטי יין" onClick={() => setAddMode('manual')} />
            <AddOption icon={Camera} title="צלם בקבוקים" desc="בקבוק אחד או כמה יחד" onClick={() => setAddMode('photo')} />
            <AddOption icon={Receipt} title="סרוק חשבונית" desc="הוסף מרשימת קנייה" onClick={() => setAddMode('invoice')} />
            <AddOption icon={Table} title="ייבוא מטבלה" desc="הדבק או העלה CSV/Excel" onClick={() => setAddMode('table')} />
          </div>
        </Modal>
      )}

      {addMode === 'manual' && (
        <Modal onClose={() => { setAddMode(null); setShowAddMenu(false); }} title="הוסף יין">
          <ManualAddForm onSubmit={addWineManually} isLoading={isAnalyzing} callClaude={callClaude} />
        </Modal>
      )}

      {(addMode === 'photo' || addMode === 'invoice') && (
        <Modal onClose={() => { setAddMode(null); setShowAddMenu(false); setDebugInfo(null); }} title={addMode === 'photo' ? 'צילום בקבוקים' : 'סריקת חשבונית'}>
          <PhotoUpload mode={addMode} onAnalyze={analyzeWineImage} isAnalyzing={isAnalyzing} status={analysisStatus} debugInfo={debugInfo} />
        </Modal>
      )}

      {addMode === 'table' && (
        <Modal onClose={() => { setAddMode(null); setShowAddMenu(false); }} title="ייבוא מטבלה">
          <TableImport onImport={importFromTable} isAnalyzing={isAnalyzing} status={analysisStatus} />
        </Modal>
      )}

      {unrecognizedImage && (
        <Modal onClose={() => { setUnrecognizedImage(null); setAddMode(null); setShowAddMenu(false); }} title="זיהוי היין">
          <UnrecognizedHelper
            image={unrecognizedImage}
            onConfirm={confirmIdentifiedWine}
            onCancel={() => { setUnrecognizedImage(null); setAddMode(null); setShowAddMenu(false); }}
            callClaude={callClaude}
          />
        </Modal>
      )}

      {wineToReidentify && (
        <Modal onClose={() => setWineToReidentify(null)} title="בחירת יין נכון">
          <ReidentifyHelper
            wine={wineToReidentify}
            onReplace={(newData) => replaceWine(wineToReidentify.id, newData)}
            onCancel={() => setWineToReidentify(null)}
            callClaude={callClaude}
          />
        </Modal>
      )}

      {wineToReenrich && (
        <Modal onClose={() => setWineToReenrich(null)} title="חיפוש מידע נוסף">
          <ReenrichHelper
            wine={wineToReenrich}
            onReenrich={(hints) => reenrichWineWithHints(wineToReenrich.id, hints)}
            onCancel={() => setWineToReenrich(null)}
          />
        </Modal>
      )}

      {mergeToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[calc(100%-32px)] safe-bottom" style={{ animation: 'toastIn 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)' }}>
          <div className="rounded-2xl p-4 backdrop-blur-2xl border border-white/10 shadow-2xl flex items-start gap-3" style={{ background: 'rgba(29, 29, 31, 0.92)', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: '#7ba87b' }}>
              <Check className="w-4 h-4 text-white" strokeWidth={3} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-[14px] font-semibold mb-1">
                {mergeToast.items.length === 1 ? 'יין אוחד עם רשומה קיימת' : `${mergeToast.items.length} יינות אוחדו`}
              </div>
              <div className="text-white/70 text-[12px] space-y-0.5">
                {mergeToast.items.slice(0, 3).map((m, i) => (
                  <div key={i} className="truncate">
                    {m.name}{m.vintage ? ` ${m.vintage}` : ''} — סה"כ {m.totalQty} בקבוקים
                  </div>
                ))}
                {mergeToast.items.length > 3 && <div>ועוד {mergeToast.items.length - 3}...</div>}
              </div>
            </div>
            <button onClick={() => setMergeToast(null)} className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0">
              <X className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
            </button>
          </div>
          <style>{`@keyframes toastIn { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }`}</style>
        </div>
      )}
    </div>
  );
}

function CellarView({ wines, allWines, searchQuery, setSearchQuery, filterType, setFilterType, sortBy, setSortBy, onSelectWine, getDrinkStatus, getWineColor, translateType, onOpenAdd }) {
  if (allWines.length === 0) {
    return (
      <div className="text-center py-24">
        <img src="/icon-192.png" alt="מרתף היין" className="w-24 h-24 mx-auto mb-6 rounded-[22px]" style={{ boxShadow: '0 8px 24px rgba(92, 26, 27, 0.18)' }} />
        <h2 className="text-2xl font-semibold mb-2" style={{ color: '#1d1d1f' }}>המרתף שלך מחכה</h2>
        <p className="text-gray-500 mb-6 text-[15px]">הוסף את הבקבוקים הראשונים שלך</p>
        <button onClick={onOpenAdd} className="h-11 px-6 rounded-full text-white text-[15px] font-medium transition-all active:scale-95" style={{
          background: 'linear-gradient(135deg, #5c1a1b, #3a1011)',
          boxShadow: '0 4px 16px rgba(92, 26, 27, 0.3)'
        }}>
          התחל את האוסף
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 space-y-3">
        <div className="relative">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" strokeWidth={2} />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="חפש לפי שם, יקב, זן או אזור" className="w-full h-11 pr-11 pl-4 rounded-2xl bg-white/70 backdrop-blur-xl border border-black/5 text-[15px] outline-none focus:border-black/20" />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[{ id: 'all', label: 'הכל' }, { id: 'red', label: 'אדום' }, { id: 'white', label: 'לבן' }, { id: 'rose', label: 'רוזה' }, { id: 'sparkling', label: 'מבעבע' }, { id: 'dessert', label: 'קינוח' }].map(f => (
            <button key={f.id} onClick={() => setFilterType(f.id)} className={"shrink-0 h-8 px-3.5 rounded-full text-[13px] font-medium transition-all " + (filterType === f.id ? 'text-white' : 'bg-white/70 text-gray-700 border border-black/5')} style={filterType === f.id ? { background: '#1d1d1f' } : {}}>
              {f.label}
            </button>
          ))}
          <div className="w-px bg-black/10 mx-1 shrink-0" />
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="shrink-0 h-8 px-3 rounded-full text-[13px] font-medium bg-white/70 border border-black/5 outline-none">
            <option value="added">לפי הוספה</option>
            <option value="score">לפי ציון</option>
            <option value="vintage">לפי בציר</option>
            <option value="name">לפי שם</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
        {wines.map((wine, idx) => (
          <WineCard key={wine.id} wine={wine} onClick={() => onSelectWine(wine)} getDrinkStatus={getDrinkStatus} getWineColor={getWineColor} translateType={translateType} index={idx} />
        ))}
      </div>

      {wines.length === 0 && allWines.length > 0 && (
        <div className="text-center py-16 text-gray-500 text-[15px]">לא נמצאו תוצאות</div>
      )}
      <style>{`@keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}

function WineCard({ wine, onClick, getDrinkStatus, getWineColor, translateType, index }) {
  const status = getDrinkStatus(wine);
  const colors = getWineColor(wine.type);

  return (
    <button onClick={onClick} className="group text-right relative overflow-hidden rounded-2xl bg-white/80 backdrop-blur-xl border border-black/5 hover:border-black/10 transition-all active:scale-[0.98]" style={{
      boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 20px rgba(0,0,0,0.03)',
      animation: 'slideUp 0.5s ' + (index * 0.04) + 's both cubic-bezier(0.2, 0.9, 0.3, 1)'
    }}>
      <div className={"relative h-40 overflow-hidden flex items-end justify-center " + (wine.labelImage ? 'bg-gray-100' : 'bg-gradient-to-b ' + colors.bg)}>
        {wine.labelImage ? (
          <img src={wine.labelImage} alt={wine.name} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="relative" style={{ width: '50px', height: '130px' }}>
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3 h-8 rounded-t-sm" style={{ background: 'rgba(0,0,0,0.4)' }} />
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-4 h-3" style={{ background: 'rgba(0,0,0,0.5)', borderRadius: '2px' }} />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 rounded-b-sm" style={{
              height: '100px',
              background: 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.35) 100%)',
              boxShadow: 'inset 2px 0 4px rgba(255,255,255,0.1), inset -2px 0 4px rgba(0,0,0,0.3)'
            }}>
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-10 h-16 rounded flex flex-col items-center justify-center px-0.5 text-center" style={{
                background: 'linear-gradient(180deg, #f5efe0, #e8dfc8)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
              }}>
                <div className="text-[6px] font-bold leading-tight" style={{ color: colors.accent }}>{wine.producer?.slice(0, 10) || 'WINE'}</div>
                <div className="w-6 h-px my-0.5" style={{ background: colors.accent }} />
                <div className="text-[5px] leading-tight opacity-70" style={{ color: colors.accent }}>{wine.vintage || ''}</div>
              </div>
            </div>
          </div>
        )}

        {status && (
          <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full text-[10px] font-semibold backdrop-blur-lg border border-white/20" style={{ background: status.color + 'dd', color: 'white' }}>
            {status.label}
          </div>
        )}

        <div className="absolute top-2.5 left-2.5 min-w-[26px] h-[22px] px-1.5 rounded-full backdrop-blur-lg flex items-center justify-center text-[11px] font-bold text-white border border-white/20" style={{ background: 'rgba(0,0,0,0.55)' }}>
          ×{wine.quantity || 1}
        </div>

        {wine.criticScore && (
          <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1 px-2 py-1 rounded-full backdrop-blur-lg" style={{ background: 'rgba(255,255,255,0.95)' }}>
            <Star className="w-2.5 h-2.5" fill="#d4a574" stroke="#d4a574" />
            <span className="text-[11px] font-bold" style={{ color: '#1d1d1f' }}>{wine.criticScore}</span>
          </div>
        )}
        {wine._enriching && (
          <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1 px-2 py-1 rounded-full backdrop-blur-lg" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <Loader2 className="w-2.5 h-2.5 animate-spin text-white" />
            <span className="text-[10px] font-medium text-white">מעשיר</span>
          </div>
        )}
      </div>

      <div className="p-3">
        <h3 className="text-[13px] font-semibold leading-tight line-clamp-1 mb-0.5" style={{ color: '#1d1d1f' }}>{wine.name || 'יין ללא שם'}</h3>
        <p className="text-[11px] text-gray-500 line-clamp-1 mb-1">{wine.producer}</p>
        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
          {wine.vintage && <span className="font-medium" style={{ color: colors.accent }}>{wine.vintage}</span>}
          {wine.vintage && wine.type && <span>·</span>}
          {wine.type && <span>{translateType(wine.type)}</span>}
          {!wine.price && <span className="mr-auto text-[10px] text-gray-300" title="ללא מחיר רכישה">₪?</span>}
        </div>
      </div>
    </button>
  );
}

function WineDetail({ wine, onBack, onDelete, onUpdateQuantity, onReidentify, onReenrich, onUpdateFields, getDrinkStatus, getWineColor, translateType }) {
  const status = getDrinkStatus(wine);
  const colors = getWineColor(wine.type);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [priceCurrency, setPriceCurrency] = useState('ILS');

  const savePrice = () => {
    const val = parseFloat(priceInput);
    if (!isNaN(val) && val > 0) {
      onUpdateFields({ price: val, currency: priceCurrency });
    }
    setEditingPrice(false);
    setPriceInput('');
  };

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-[14px] font-medium flex items-center gap-1 hover:opacity-70" style={{ color: '#5c1a1b' }}>
        <span style={{ transform: 'rotate(180deg)', display: 'inline-block' }}>‹</span> חזרה למרתף
      </button>

      {wine.labelImage ? (
        // Real photo hero
        <div className="relative rounded-3xl overflow-hidden mb-5" style={{ boxShadow: '0 10px 40px rgba(0,0,0,0.15)', aspectRatio: '4/5', maxHeight: '480px' }}>
          <img src={wine.labelImage} alt={wine.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.4) 70%, rgba(0,0,0,0.85) 100%)' }} />
          <div className="absolute bottom-0 left-0 right-0 p-6 text-white">
            {status && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-3 backdrop-blur-md border border-white/20" style={{ background: 'rgba(255,255,255,0.18)' }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: status.color }} />
                {status.label}
              </div>
            )}
            <h1 className="text-2xl md:text-3xl font-bold mb-1 leading-tight drop-shadow-lg">{wine.name}</h1>
            <p className="text-[15px] opacity-90 mb-3 drop-shadow">{wine.producer}</p>
            <div className="flex flex-wrap gap-2 text-[12px]">
              {wine.vintage && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.15)' }}>{wine.vintage}</div>}
              {wine.type && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.15)' }}>{translateType(wine.type)}</div>}
              {wine.grape && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.15)' }}>{wine.grape}</div>}
              {wine.region && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15 flex items-center gap-1" style={{ background: 'rgba(255,255,255,0.15)' }}>
                <MapPin className="w-3 h-3" /> {wine.region}
              </div>}
            </div>
          </div>
        </div>
      ) : (
        // Illustrated bottle hero
        <div className={"relative rounded-3xl overflow-hidden mb-5 bg-gradient-to-br " + colors.bg} style={{ minHeight: '260px', boxShadow: '0 10px 40px rgba(0,0,0,0.15)' }}>
          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at top, rgba(255,255,255,0.15), transparent 70%)' }} />

          <div className="absolute bottom-0 right-8 md:right-16">
            <div className="relative" style={{ width: '90px', height: '220px' }}>
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-5 h-12 rounded-t" style={{ background: 'rgba(0,0,0,0.45)' }} />
              <div className="absolute top-3 left-1/2 -translate-x-1/2 w-7 h-5" style={{ background: 'rgba(0,0,0,0.55)', borderRadius: '3px' }} />
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[88px] rounded-b" style={{
                height: '170px',
                background: 'linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0.35))',
                boxShadow: 'inset 3px 0 6px rgba(255,255,255,0.12), inset -3px 0 6px rgba(0,0,0,0.3)'
              }}>
                <div className="absolute top-6 left-1/2 -translate-x-1/2 w-16 h-28 rounded flex flex-col items-center justify-center px-1 text-center" style={{
                  background: 'linear-gradient(180deg, #f5efe0, #e8dfc8)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.25)'
                }}>
                  <div className="text-[8px] font-bold leading-tight" style={{ color: colors.accent }}>{wine.producer?.slice(0, 14) || ''}</div>
                  <div className="w-10 h-px my-1" style={{ background: colors.accent }} />
                  <div className="text-[7px] leading-tight" style={{ color: colors.accent, opacity: 0.8 }}>{wine.name?.slice(0, 20)}</div>
                  <div className="text-[9px] font-bold mt-1" style={{ color: colors.accent }}>{wine.vintage || ''}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative p-6 md:p-8 text-white max-w-[60%]">
            {status && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-3 backdrop-blur-md border border-white/20" style={{ background: 'rgba(255,255,255,0.18)' }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: status.color }} />
                {status.label}
              </div>
            )}
            <h1 className="text-2xl md:text-3xl font-bold mb-1 leading-tight">{wine.name}</h1>
            <p className="text-[15px] opacity-80 mb-3">{wine.producer}</p>
            <div className="flex flex-wrap gap-2 text-[12px]">
              {wine.vintage && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.12)' }}>{wine.vintage}</div>}
              {wine.type && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.12)' }}>{translateType(wine.type)}</div>}
              {wine.grape && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15" style={{ background: 'rgba(255,255,255,0.12)' }}>{wine.grape}</div>}
              {wine.region && <div className="px-2.5 py-1 rounded-full backdrop-blur-md border border-white/15 flex items-center gap-1" style={{ background: 'rgba(255,255,255,0.12)' }}>
                <MapPin className="w-3 h-3" /> {wine.region}
              </div>}
            </div>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {(wine.labelImage || onReenrich) && (
        <div className="grid grid-cols-1 gap-2 mb-4">
          {wine.labelImage && onReidentify && (
            <button onClick={onReidentify} className="h-11 rounded-2xl bg-white/80 backdrop-blur-xl border border-black/5 hover:border-black/10 flex items-center justify-center gap-2 text-[13px] font-medium transition-all active:scale-[0.99]" style={{ color: '#5c1a1b' }}>
              <Search className="w-4 h-4" strokeWidth={2} />
              זה לא היין הנכון? בחר אחר
            </button>
          )}
          {onReenrich && (
            <button onClick={onReenrich} disabled={wine._enriching} className="h-11 rounded-2xl bg-white/80 backdrop-blur-xl border border-black/5 hover:border-black/10 flex items-center justify-center gap-2 text-[13px] font-medium transition-all active:scale-[0.99] disabled:opacity-50" style={{ color: '#5c1a1b' }}>
              {wine._enriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" strokeWidth={2} />}
              {wine._enriching ? 'מעשיר...' : 'חפש מידע נוסף / נכון יותר'}
            </button>
          )}
        </div>
      )}

      <div className="mb-4 p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5 flex items-center justify-between">
        <div>
          <div className="text-[12px] text-gray-500 mb-0.5">במלאי</div>
          <div className="text-xl font-bold" style={{ color: '#1d1d1f' }}>{wine.quantity || 1} בקבוקים</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onUpdateQuantity(-1)} className="w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-all active:scale-95 text-xl font-medium">−</button>
          <button onClick={() => onUpdateQuantity(1)} className="w-10 h-10 rounded-full text-white flex items-center justify-center transition-all active:scale-95 text-xl font-medium" style={{ background: '#5c1a1b' }}>+</button>
        </div>
      </div>

      {/* Price card — shown when editing, or when price is missing, or when user clicks to edit */}
      {onUpdateFields && (editingPrice ? (
        <div className="mb-4 p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5">
          <div className="text-[12px] text-gray-500 mb-2">מחיר רכישה</div>
          <div className="flex gap-2 items-stretch">
            <input
              type="number"
              value={priceInput}
              onChange={e => setPriceInput(e.target.value)}
              placeholder="0"
              autoFocus
              inputMode="decimal"
              className="flex-1 h-11 px-3 rounded-xl bg-gray-50 border border-black/5 outline-none focus:border-black/20 text-[15px]"
            />
            <select value={priceCurrency} onChange={e => setPriceCurrency(e.target.value)} className="h-11 px-2 rounded-xl bg-gray-50 border border-black/5 outline-none text-[14px]">
              <option value="ILS">₪</option>
              <option value="USD">$</option>
              <option value="EUR">€</option>
              <option value="GBP">£</option>
            </select>
            <button onClick={savePrice} className="px-4 h-11 rounded-xl text-white font-semibold text-[13px]" style={{ background: '#5c1a1b' }}>שמור</button>
            <button onClick={() => { setEditingPrice(false); setPriceInput(''); }} className="px-3 h-11 rounded-xl bg-gray-100 text-[13px]">ביטול</button>
          </div>
        </div>
      ) : !wine.price ? (
        <button onClick={() => { setPriceInput(''); setPriceCurrency(wine.currency || 'ILS'); setEditingPrice(true); }} className="w-full mb-4 p-3 bg-white/60 backdrop-blur-xl rounded-2xl border border-dashed border-gray-300 hover:border-gray-400 text-[13px] text-gray-500 hover:text-gray-700 font-medium flex items-center justify-center gap-2 transition-all active:scale-[0.99]">
          <Plus className="w-4 h-4" strokeWidth={2} />
          הוסף מחיר רכישה
        </button>
      ) : (
        <div className="mb-4 p-3 bg-white/60 backdrop-blur-xl rounded-2xl border border-black/5 flex items-center justify-between">
          <div className="text-[13px] text-gray-600">
            <span className="text-gray-400">מחיר רכישה · </span>
            <span className="font-semibold" style={{ color: '#1d1d1f' }}>{wine.price} {wine.currency || '₪'}</span>
          </div>
          <button onClick={() => { setPriceInput(String(wine.price)); setPriceCurrency(wine.currency || 'ILS'); setEditingPrice(true); }} className="text-[12px] font-medium hover:opacity-70" style={{ color: '#5c1a1b' }}>
            ערוך
          </button>
        </div>
      ))}

      {wine.marketValue && (
        <div className="mb-4 p-3 bg-gradient-to-l from-amber-50/60 to-white rounded-2xl border border-amber-100/60 flex items-center justify-between">
          <div className="text-[13px] text-gray-600">
            <span className="text-gray-400">שווי שוק נוכחי · </span>
            <span className="font-semibold" style={{ color: '#1d1d1f' }}>${Math.round(wine.marketValue)}</span>
          </div>
          <TrendingUp className="w-4 h-4" style={{ color: '#d4a574' }} strokeWidth={2} />
        </div>
      )}

      {wine.criticScore && (
        <Section icon={Award} title="ציון מבקרים">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-20 h-20 rounded-2xl flex flex-col items-center justify-center" style={{
              background: 'linear-gradient(135deg, #d4a574, #b8894f)',
              boxShadow: '0 4px 16px rgba(184, 137, 79, 0.35)'
            }}>
              <div className="text-2xl font-bold text-white">{wine.criticScore}</div>
              <div className="text-[10px] text-white/80 font-medium">/ 100</div>
            </div>
            {wine.criticNotes && <p className="text-[14px] leading-relaxed text-gray-700 pt-1">{wine.criticNotes}</p>}
          </div>
        </Section>
      )}

      {(wine.drinkFrom || wine.drinkBy) && (
        <Section icon={Clock} title="חלון שתייה">
          <DrinkingWindow wine={wine} />
        </Section>
      )}

      {wine.tastingNotes && (
        <Section icon={Droplet} title="תווי טעימה">
          <p className="text-[14px] leading-relaxed text-gray-700">{wine.tastingNotes}</p>
        </Section>
      )}

      {wine.foodPairings && wine.foodPairings.length > 0 && (
        <Section icon={ChefHat} title="שילוב עם אוכל">
          <div className="grid grid-cols-2 gap-2">
            {wine.foodPairings.map((food, i) => (
              <div key={i} className="px-3 py-2.5 rounded-xl bg-gray-50 border border-black/5 text-[13px] flex items-center gap-2">
                <div className="w-1 h-1 rounded-full" style={{ background: colors.accent }} />
                {food}
              </div>
            ))}
          </div>
        </Section>
      )}

      {(wine.servingTemp || wine.decant !== undefined || wine.alcohol) && (
        <Section icon={ThermometerSun} title="הגשה">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {wine.servingTemp && <InfoPill label="טמפרטורה" value={wine.servingTemp} />}
            {wine.decant !== undefined && <InfoPill label="דיקנטציה" value={wine.decant ? 'מומלץ' : 'לא נדרש'} />}
            {wine.alcohol && <InfoPill label="אלכוהול" value={wine.alcohol + '%'} />}
          </div>
        </Section>
      )}

      <div className="mt-6 pt-6 border-t border-black/5 flex items-center justify-between">
        <div className="text-[12px] text-gray-400">
          נוסף {new Date(wine.addedAt).toLocaleDateString('he-IL')}
        </div>
        <button onClick={() => confirmDelete ? onDelete() : setConfirmDelete(true)} className={"text-[13px] font-medium flex items-center gap-1 px-3 py-1.5 rounded-full transition-all " + (confirmDelete ? 'bg-red-500 text-white' : 'text-red-500 hover:bg-red-50')}>
          <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          {confirmDelete ? 'לחץ שוב לאישור' : 'מחק'}
        </button>
      </div>
    </div>
  );
}

function DrinkingWindow({ wine }) {
  const currentYear = new Date().getFullYear();
  const from = wine.drinkFrom || currentYear;
  const to = wine.drinkBy || currentYear + 5;
  const peak = wine.peakYear;
  const range = Math.max(1, to - from);

  // Clamp position but remember if we're outside the window
  const rawPosition = ((currentYear - from) / range) * 100;
  const position = Math.max(0, Math.min(100, rawPosition));
  const peakPos = peak ? Math.max(0, Math.min(100, ((peak - from) / range) * 100)) : null;

  const isBefore = currentYear < from;
  const isAfter = currentYear > to;
  const isOutside = isBefore || isAfter;

  return (
    <div dir="ltr">
      {/* Year labels: left = from, right = to, forced LTR to keep order correct */}
      <div className="flex items-center justify-between mb-2 text-[12px] font-medium text-gray-500">
        <span>{from}</span>
        {peak && <span style={{ color: '#d4a574' }} dir="rtl">שיא: {peak}</span>}
        <span>{to}</span>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, #8b9dc3 0%, #7ba87b 30%, #d4a574 70%, #a0a0a0 100%)' }} />
        {peakPos !== null && (
          <div className="absolute top-1/2 -translate-y-1/2 w-1 h-4 rounded-full" style={{ left: peakPos + '%', background: '#d4a574', boxShadow: '0 0 0 2px white' }} />
        )}
        <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2" style={{
          left: 'calc(' + position + '% - 6px)',
          background: isOutside ? '#ef4444' : 'white',
          borderColor: isOutside ? '#b91c1c' : '#1d1d1f',
          boxShadow: isOutside ? '0 0 0 3px rgba(239, 68, 68, 0.2)' : '0 2px 4px rgba(0,0,0,0.15)'
        }} />
      </div>
      <div className="text-[12px] text-center mt-2 font-medium" dir="rtl" style={{ color: isOutside ? '#b91c1c' : '#1d1d1f' }}>
        {isBefore && '⚠️ מוקדם מדי · '}
        {isAfter && '⚠️ עבר את השיא · '}
        היום · {currentYear}
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="mb-4 p-5 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4" style={{ color: '#5c1a1b' }} strokeWidth={2} />
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-gray-600">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function InfoPill({ label, value }) {
  return (
    <div className="px-3 py-2.5 rounded-xl bg-gray-50 border border-black/5">
      <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{label}</div>
      <div className="text-[13px] font-semibold mt-0.5" style={{ color: '#1d1d1f' }}>{value}</div>
    </div>
  );
}

function RecommendationsView({ allWines, onSelectWine, getWineColor, translateType, callClaude, getDrinkStatus }) {
  const [occasion, setOccasion] = useState('');
  const [food, setFood] = useState('');
  const [aiRec, setAiRec] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  const readyToDrink = allWines.filter(w => {
    const s = getDrinkStatus(w);
    return s?.status === 'ready' || s?.status === 'peak';
  });

  const askAI = async () => {
    if (allWines.length === 0) return;
    setAiLoading(true);
    try {
      const wineList = allWines.map(w => '- ' + w.name + ' ' + (w.vintage || '') + ' (' + (w.producer || '') + ', ' + (translateType(w.type) || '') + ', כמות: ' + (w.quantity || 1) + (w.criticScore ? ', ציון: ' + w.criticScore : '') + ')').join('\n');

      const prompt = 'מאוסף היינות הבא, המלץ על יין אחד שמתאים ל' + (occasion ? 'אירוע: ' + occasion : '') + (food ? ' ואוכל: ' + food : '') + ':\n\n' + wineList + '\n\nהחזר JSON בלבד: {"wineName": "שם מדויק מהרשימה", "reason": "נימוק מקצועי בעברית 2-3 משפטים", "servingTip": "טיפ הגשה קצר"}';
      const result = await callClaude([{ role: 'user', content: prompt }], 800);
      const cleaned = result.replace(/```json\n?|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const matchedWine = allWines.find(w => w.name?.includes(parsed.wineName) || parsed.wineName.includes(w.name));
      setAiRec({ ...parsed, wine: matchedWine });
    } catch (e) { console.error(e); }
    setAiLoading(false);
  };

  return (
    <div>
      <div className="relative rounded-3xl p-6 mb-6 overflow-hidden" style={{ background: 'linear-gradient(135deg, #1d1d1f, #2a2a2c)', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
        <div className="absolute top-0 right-0 w-64 h-64 rounded-full opacity-20" style={{ background: 'radial-gradient(circle, #d4a574, transparent 70%)', transform: 'translate(30%, -30%)' }} />
        <div className="relative">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5" style={{ color: '#d4a574' }} strokeWidth={2} />
            <h2 className="text-white text-lg font-semibold">הסומלייה שלך</h2>
          </div>
          <p className="text-white/70 text-[14px] mb-4">ספר לי מה התוכניות שלך ואמליץ מהאוסף</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-3">
            <input type="text" value={occasion} onChange={e => setOccasion(e.target.value)} placeholder="למשל: ארוחת ערב רומנטית" className="h-11 px-4 rounded-xl text-[14px] outline-none" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', color: 'white' }} />
            <input type="text" value={food} onChange={e => setFood(e.target.value)} placeholder="למשל: סטייק עם פטריות" className="h-11 px-4 rounded-xl text-[14px] outline-none" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', color: 'white' }} />
          </div>
          <button onClick={askAI} disabled={aiLoading || allWines.length === 0} className="h-11 px-5 rounded-xl text-[14px] font-semibold text-black transition-all active:scale-95 disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #d4a574, #b8894f)' }}>
            {aiLoading ? <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> מכין המלצה...</span> : 'המלץ לי'}
          </button>

          {aiRec && aiRec.wine && (
            <div className="mt-5 p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <div className="text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: '#d4a574' }}>המלצת השף</div>
              <button onClick={() => onSelectWine(aiRec.wine)} className="text-white text-lg font-bold mb-1 hover:underline text-right block">{aiRec.wine.name}</button>
              <div className="text-white/60 text-[12px] mb-3">{aiRec.wine.producer} · {aiRec.wine.vintage || ''}</div>
              <p className="text-white/85 text-[14px] leading-relaxed mb-3">{aiRec.reason}</p>
              {aiRec.servingTip && (
                <div className="text-[12px] text-white/60 flex items-start gap-1.5">
                  <ThermometerSun className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{aiRec.servingTip}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mb-3">
        <h2 className="text-xl font-bold mb-1" style={{ color: '#1d1d1f' }}>מוכנים עכשיו</h2>
        <p className="text-[13px] text-gray-500 mb-4">יינות בחלון השתייה האופטימלי</p>
      </div>

      {readyToDrink.length === 0 ? (
        <div className="p-6 bg-white/70 rounded-2xl border border-black/5 text-center text-gray-500 text-[14px]">אין כרגע יינות מוכנים לשתייה באוסף</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {readyToDrink.map(wine => {
            const colors = getWineColor(wine.type);
            return (
              <button key={wine.id} onClick={() => onSelectWine(wine)} className="text-right p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5 hover:border-black/10 transition-all active:scale-[0.99] flex items-center gap-3">
                <div className="w-12 h-16 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(180deg, ' + colors.accent + ', rgba(0,0,0,0.6))' }}>
                  <Wine className="w-5 h-5 text-white/80" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[14px] truncate" style={{ color: '#1d1d1f' }}>{wine.name}</div>
                  <div className="text-[12px] text-gray-500 truncate">{wine.producer} · {wine.vintage || ''}</div>
                </div>
                {wine.criticScore && (
                  <div className="text-center shrink-0">
                    <div className="text-lg font-bold" style={{ color: colors.accent }}>{wine.criticScore}</div>
                    <div className="text-[9px] text-gray-400">ציון</div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatsView({ wines, totalBottles, translateType }) {
  const avgScore = wines.length ? Math.round(wines.reduce((s,w) => s+(w.criticScore||0),0) / Math.max(1, wines.filter(w=>w.criticScore).length)) : 0;
  const byType = wines.reduce((acc, w) => { const t = translateType(w.type) || 'אחר'; acc[t] = (acc[t] || 0) + (w.quantity || 1); return acc; }, {});
  const byRegion = wines.reduce((acc, w) => { const r = w.region || 'לא מוגדר'; acc[r] = (acc[r] || 0) + (w.quantity || 1); return acc; }, {});
  const topRegions = Object.entries(byRegion).sort((a,b) => b[1] - a[1]).slice(0, 5);
  const typeColors = { 'אדום': '#8b2635', 'לבן': '#d4b85a', 'רוזה': '#e89999', 'מבעבע': '#e8d080', 'קינוח': '#a06830', 'מחוזק': '#7a4a20', 'אחר': '#999' };

  // ─── Value calculation ───
  // USD to ILS approximate conversion (just for display — user's prices may be in ILS already)
  const USD_TO_ILS = 3.7;
  const normalizeToILS = (value, currency) => {
    if (!value) return 0;
    const c = (currency || 'ILS').toUpperCase();
    if (c === 'ILS' || c === '₪') return value;
    if (c === 'USD' || c === '$') return value * USD_TO_ILS;
    if (c === 'EUR' || c === '€') return value * 4.0;
    if (c === 'GBP' || c === '£') return value * 4.7;
    return value;
  };

  // Cost: what the user paid
  const totalCost = wines.reduce((sum, w) => sum + normalizeToILS(w.price, w.currency) * (w.quantity || 1), 0);
  const winesWithPrice = wines.filter(w => w.price).length;
  const winesMissingPrice = wines.length - winesWithPrice;

  // Market value: sum of marketValue (usually USD) × quantity, converted to ILS
  const totalMarketValue = wines.reduce((sum, w) => sum + normalizeToILS(w.marketValue, w.marketValueCurrency || 'USD') * (w.quantity || 1), 0);
  const winesWithMarketValue = wines.filter(w => w.marketValue).length;

  const delta = totalMarketValue - totalCost;
  const deltaPct = totalCost > 0 ? (delta / totalCost) * 100 : 0;
  const hasEnoughData = totalCost > 0 && totalMarketValue > 0;

  const formatILS = (n) => '₪' + Math.round(n).toLocaleString();

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <StatCard label="בקבוקים" value={totalBottles} color="#5c1a1b" />
        <StatCard label="תוויות" value={wines.length} color="#1d1d1f" />
      </div>

      {/* Value cards */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5">
          <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wide mb-1">השקעה</div>
          <div className="text-2xl font-bold" style={{ color: '#1d1d1f' }}>{totalCost ? formatILS(totalCost) : '—'}</div>
          {winesMissingPrice > 0 && (
            <div className="text-[11px] text-gray-400 mt-1">
              {winesMissingPrice} ללא מחיר
            </div>
          )}
        </div>
        <div className="p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5">
          <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wide mb-1">שווי שוק</div>
          <div className="text-2xl font-bold" style={{ color: '#5c1a1b' }}>{totalMarketValue ? formatILS(totalMarketValue) : '—'}</div>
          {winesWithMarketValue < wines.length && (
            <div className="text-[11px] text-gray-400 mt-1">
              על בסיס {winesWithMarketValue}/{wines.length}
            </div>
          )}
        </div>
      </div>

      {/* Delta card */}
      {hasEnoughData && (
        <div className="p-4 mb-3 rounded-2xl border" style={{
          background: delta >= 0 ? 'linear-gradient(135deg, rgba(123, 168, 123, 0.08), rgba(123, 168, 123, 0.02))' : 'linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.02))',
          borderColor: delta >= 0 ? 'rgba(123, 168, 123, 0.25)' : 'rgba(239, 68, 68, 0.25)'
        }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide mb-0.5" style={{ color: delta >= 0 ? '#5a7c5a' : '#9b2828' }}>
                {delta >= 0 ? 'רווח פוטנציאלי' : 'ירידה'}
              </div>
              <div className="text-xl font-bold" style={{ color: delta >= 0 ? '#5a7c5a' : '#9b2828' }}>
                {delta >= 0 ? '+' : ''}{formatILS(delta)}
              </div>
            </div>
            <div className="text-left">
              <div className="text-[22px] font-bold" style={{ color: delta >= 0 ? '#5a7c5a' : '#9b2828' }}>
                {delta >= 0 ? '↑' : '↓'} {Math.abs(deltaPct).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 mb-5">
        <StatCard label="ציון ממוצע" value={avgScore || '—'} color="#d4a574" />
      </div>

      {Object.keys(byType).length > 0 && (
        <Section icon={Grape} title="התפלגות לפי סוג">
          <div className="space-y-2">
            {Object.entries(byType).sort((a,b) => b[1]-a[1]).map(([type, count]) => {
              const pct = (count / totalBottles) * 100;
              return (
                <div key={type}>
                  <div className="flex justify-between text-[13px] mb-1">
                    <span className="font-medium" style={{ color: '#1d1d1f' }}>{type}</span>
                    <span className="text-gray-500">{count} בקבוקים · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: pct + '%', background: typeColors[type] || '#999' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {topRegions.length > 0 && (
        <Section icon={MapPin} title="אזורים מובילים">
          <div className="space-y-2">
            {topRegions.map(([region, count], i) => (
              <div key={region} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ background: i === 0 ? '#d4a574' : '#f4efe8', color: i === 0 ? 'white' : '#999' }}>{i+1}</div>
                  <span className="text-[14px] font-medium" style={{ color: '#1d1d1f' }}>{region}</span>
                </div>
                <span className="text-[13px] text-gray-500">{count} בקבוקים</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="p-4 bg-white/80 backdrop-blur-xl rounded-2xl border border-black/5">
      <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(10px)' }} onClick={onClose} dir="rtl">
      <div className="w-full max-w-md bg-white/95 backdrop-blur-2xl rounded-t-3xl md:rounded-3xl p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()} style={{ boxShadow: '0 -10px 40px rgba(0,0,0,0.2)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" style={{ color: '#1d1d1f' }}>{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-all active:scale-90">
            <X className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddOption({ icon: Icon, title, desc, onClick }) {
  return (
    <button onClick={onClick} className="w-full p-4 bg-gray-50 hover:bg-gray-100 rounded-2xl flex items-center gap-3 text-right transition-all active:scale-[0.98]">
      <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)' }}>
        <Icon className="w-5 h-5 text-white" strokeWidth={1.8} />
      </div>
      <div className="flex-1">
        <div className="font-semibold text-[15px]" style={{ color: '#1d1d1f' }}>{title}</div>
        <div className="text-[12px] text-gray-500">{desc}</div>
      </div>
      <span className="text-gray-400 text-xl">‹</span>
    </button>
  );
}

function ManualAddForm({ onSubmit, isLoading, callClaude }) {
  const [mode, setMode] = useState('search'); // search, details
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(null);
  const [form, setForm] = useState({ name: '', producer: '', vintage: '', type: 'red', grape: '', region: '', quantity: 1, price: '', currency: 'ILS' });
  const debounceRef = useRef(null);
  const lastQueryRef = useRef('');

  // Live search as user types (debounced)
  useEffect(() => {
    if (mode !== 'search') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      lastQueryRef.current = q;
      setSearching(true);

      const doSearch = async (useWebSearch) => {
        const prompt = useWebSearch
          ? `You are a wine search assistant. The user is searching for: "${q}"

Search Wine-Searcher.com, Vivino, and similar wine databases to find up to 6 REAL wines matching this query.

Return ONLY valid JSON (no markdown):
{"results":[{"name":"Full wine name","producer":"Producer","vintage":2019,"type":"red","grape":"Grape variety","region":"Region, Country","avgPrice":"$25-40","description":"1-sentence description in Hebrew"}]}

CRITICAL:
- type must be VERIFIED: red, white, rose, sparkling, dessert, or fortified
- Only list real wines found in search
- Order by relevance`
          : `You are a wine expert. Suggest up to 6 wines matching: "${q}"

Return ONLY valid JSON (no markdown):
{"results":[{"name":"Full wine name","producer":"Producer","vintage":2019,"type":"red","grape":"Grape variety","region":"Region, Country","avgPrice":"$25-40","description":"1-sentence description in Hebrew"}]}

type must be: red, white, rose, sparkling, dessert, or fortified.`;

        const result = await callClaude([{ role: 'user', content: prompt }], 1800, useWebSearch ? { useWebSearch: true, maxSearches: 2 } : {});
        let cleaned = result.replace(/```json\n?|```/g, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        if (!cleaned) throw new Error('empty response');
        const parsed = JSON.parse(cleaned);
        return parsed.results || [];
      };

      try {
        let found = [];
        try {
          found = await doSearch(true);
        } catch (webErr) {
          console.warn('Web search failed, falling back', webErr);
        }
        if (!found.length) {
          try {
            found = await doSearch(false);
          } catch (fallbackErr) {
            console.error('Fallback failed', fallbackErr);
          }
        }
        if (lastQueryRef.current !== q) return;
        setSuggestions(found);
      } catch (e) {
        console.error('Search error', e);
        if (lastQueryRef.current !== q) return;
        setSuggestions([]);
      }
      setSearching(false);
    }, 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, mode, callClaude]);

  const selectSuggestion = (s) => {
    setSelectedSuggestion(s);
    setForm({
      name: s.name || '',
      producer: s.producer || '',
      vintage: s.vintage || '',
      type: s.type || 'red',
      grape: s.grape || '',
      region: s.region || '',
      quantity: 1,
      price: '',
      currency: 'ILS'
    });
    setMode('details');
  };

  const startBlank = () => {
    setSelectedSuggestion(null);
    setForm({ name: query, producer: '', vintage: '', type: 'red', grape: '', region: '', quantity: 1, price: '', currency: 'ILS' });
    setMode('details');
  };

  const handleSubmit = () => {
    if (!form.name) return;
    onSubmit({
      ...form,
      vintage: form.vintage ? parseInt(form.vintage) : null,
      quantity: parseInt(form.quantity) || 1,
      price: form.price ? parseFloat(form.price) : null
    });
  };

  const field = (label, key, type, placeholder) => (
    <div>
      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">{label}</label>
      <input type={type || 'text'} value={form[key]} onChange={e => setForm({...form, [key]: e.target.value})} placeholder={placeholder || ''} className="w-full mt-1 h-10 px-3 rounded-xl bg-gray-50 border border-black/5 outline-none focus:border-black/20 text-[14px]" />
    </div>
  );

  const getTypeColor = (t) => {
    const map = { red: '#8b2635', white: '#b89d4f', rose: '#d47979', 'rosé': '#d47979', sparkling: '#d4bc6a', dessert: '#a06830', fortified: '#7a4a20' };
    return map[t?.toLowerCase()] || '#8b2635';
  };

  if (mode === 'search') {
    return (
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="חפש שם יין, יקב או אזור..."
            autoFocus
            className="w-full h-12 pr-11 pl-4 rounded-2xl bg-gray-50 border border-black/5 text-[15px] outline-none focus:border-black/20 focus:bg-white transition-all"
          />
          {searching && (
            <div className="absolute left-4 top-1/2 -translate-y-1/2">
              <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          )}
        </div>

        {query.length < 3 && (
          <div className="p-6 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, rgba(92, 26, 27, 0.08), rgba(92, 26, 27, 0.02))' }}>
              <Search className="w-6 h-6" style={{ color: '#5c1a1b' }} strokeWidth={1.5} />
            </div>
            <p className="text-[14px] text-gray-600 font-medium mb-1">חפש יין לפי שם</p>
            <p className="text-[12px] text-gray-400 leading-relaxed">המערכת תציע התאמות אוטומטית<br/>עם פרטים מלאים מבסיס נתוני יינות עולמי</p>
          </div>
        )}

        {query.length >= 3 && !searching && suggestions.length === 0 && (
          <div className="p-4 text-center text-[13px] text-gray-500">
            לא נמצאו תוצאות. אפשר להמשיך ולהוסיף ידנית 👇
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="space-y-1.5 max-h-[380px] overflow-y-auto -mx-1 px-1">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => selectSuggestion(s)}
                className="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 active:scale-[0.99] transition-all flex items-start gap-3"
              >
                <div className="w-9 h-12 rounded-md shrink-0 flex items-center justify-center" style={{
                  background: `linear-gradient(180deg, ${getTypeColor(s.type)}, rgba(0,0,0,0.6))`
                }}>
                  <Wine className="w-4 h-4 text-white/80" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[14px] leading-tight mb-0.5" style={{ color: '#1d1d1f' }}>
                    {s.name}
                    {s.vintage && <span className="text-gray-500 font-normal"> · {s.vintage}</span>}
                  </div>
                  <div className="text-[12px] text-gray-500 line-clamp-1">
                    {[s.producer, s.region].filter(Boolean).join(' · ')}
                  </div>
                  {(s.grape || s.avgPrice) && (
                    <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                      {s.grape && <span>{s.grape}</span>}
                      {s.grape && s.avgPrice && <span>·</span>}
                      {s.avgPrice && <span>{s.avgPrice}</span>}
                    </div>
                  )}
                </div>
                <span className="text-gray-300 text-lg shrink-0">‹</span>
              </button>
            ))}
          </div>
        )}

        {query.length >= 3 && (
          <button
            onClick={startBlank}
            className="w-full h-11 rounded-xl bg-white border border-dashed border-gray-300 hover:border-gray-400 text-[13px] font-medium text-gray-600 flex items-center justify-center gap-2 transition-all"
          >
            <Edit3 className="w-3.5 h-3.5" />
            הוסף ידנית בלי בחירה
          </button>
        )}
      </div>
    );
  }

  // details mode
  return (
    <div className="space-y-3">
      <button onClick={() => setMode('search')} className="text-[13px] font-medium flex items-center gap-1 hover:opacity-70 mb-1" style={{ color: '#5c1a1b' }}>
        <span style={{ transform: 'rotate(180deg)', display: 'inline-block' }}>‹</span> חזרה לחיפוש
      </button>

      {selectedSuggestion && (
        <div className="p-3 rounded-xl bg-gradient-to-l from-amber-50 to-transparent border border-amber-100 flex items-center gap-2 text-[12px]">
          <Check className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-gray-700">פרטים נטענו מבסיס הנתונים. תוכל לערוך ולהוסיף כמות ומחיר.</span>
        </div>
      )}

      {field('שם היין *', 'name', 'text', 'Barolo Cannubi')}
      {field('יקב', 'producer', 'text', 'Sandrone')}
      <div className="grid grid-cols-2 gap-3">
        {field('שנת בציר', 'vintage', 'number', '2019')}
        <div>
          <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">סוג</label>
          <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} className="w-full mt-1 h-10 px-3 rounded-xl bg-gray-50 border border-black/5 outline-none text-[14px]">
            <option value="red">אדום</option>
            <option value="white">לבן</option>
            <option value="rose">רוזה</option>
            <option value="sparkling">מבעבע</option>
            <option value="dessert">קינוח</option>
            <option value="fortified">מחוזק</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field('זן ענבים', 'grape', 'text', 'Nebbiolo')}
        {field('אזור', 'region', 'text', 'Piedmont, Italy')}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {field('כמות', 'quantity', 'number')}
        {field('מחיר', 'price', 'number')}
        <div>
          <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">מטבע</label>
          <select value={form.currency} onChange={e => setForm({...form, currency: e.target.value})} className="w-full mt-1 h-10 px-3 rounded-xl bg-gray-50 border border-black/5 outline-none text-[14px]">
            <option value="ILS">₪</option>
            <option value="USD">$</option>
            <option value="EUR">€</option>
            <option value="GBP">£</option>
          </select>
        </div>
      </div>
      <button onClick={handleSubmit} disabled={!form.name || isLoading} className="w-full h-12 rounded-2xl text-white font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-50 mt-4 flex items-center justify-center gap-2" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)', boxShadow: '0 4px 16px rgba(92, 26, 27, 0.3)' }}>
        {isLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> מעשיר במידע...</> : 'הוסף למרתף'}
      </button>
    </div>
  );
}

function PhotoUpload({ mode, onAnalyze, isAnalyzing, status, debugInfo }) {
  const fileInputRef = useRef(null);
  const [previews, setPreviews] = useState([]);
  const [files, setFiles] = useState([]);

  const handleFiles = (fileList) => {
    const arr = Array.from(fileList);
    setFiles(arr);
    setPreviews(arr.map(f => URL.createObjectURL(f)));
  };

  return (
    <div>
      {!previews.length ? (
        <div>
          <button onClick={() => fileInputRef.current?.click()} className="w-full py-12 rounded-2xl border-2 border-dashed border-gray-300 hover:border-gray-400 flex flex-col items-center gap-3 transition-all">
            <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)' }}>
              {mode === 'photo' ? <Camera className="w-6 h-6 text-white" strokeWidth={1.5} /> : <Receipt className="w-6 h-6 text-white" strokeWidth={1.5} />}
            </div>
            <div className="text-center">
              <div className="font-semibold text-[15px]" style={{ color: '#1d1d1f' }}>{mode === 'photo' ? 'צלם או העלה תמונה' : 'העלה צילום חשבונית'}</div>
              <div className="text-[12px] text-gray-500 mt-1">{mode === 'photo' ? 'תמונה אחת או כמה בקבוקים יחד' : 'תמונה של החשבונית'}</div>
            </div>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple={mode === 'photo'} className="hidden" onChange={e => handleFiles(e.target.files)} />
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {previews.map((src, i) => (
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
                <img src={src} alt="" className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
          {isAnalyzing ? (
            <div className="p-4 rounded-2xl bg-gray-50 border border-black/5 flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#5c1a1b' }} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-[14px]" style={{ color: '#1d1d1f' }}>{status || 'מנתח...'}</div>
                <div className="text-[11px] text-gray-500">זה יכול לקחת כמה שניות</div>
              </div>
            </div>
          ) : debugInfo ? (
            <div className="p-4 rounded-2xl bg-red-50 border border-red-200 mb-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold text-[14px] text-red-900 mb-1">שגיאה בניתוח</div>
                  <div className="text-[12px] text-red-800 break-all" style={{ direction: 'ltr', textAlign: 'left' }}>{debugInfo.message}</div>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setPreviews([]); setFiles([]); }} className="flex-1 h-10 rounded-xl bg-white border border-red-200 font-medium text-[13px] text-red-700">נסה תמונה אחרת</button>
                <button onClick={() => onAnalyze(files, mode)} className="flex-1 h-10 rounded-xl text-white font-semibold text-[13px]" style={{ background: '#5c1a1b' }}>נסה שוב</button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => { setPreviews([]); setFiles([]); }} className="flex-1 h-11 rounded-xl bg-gray-100 font-medium text-[14px] transition-all active:scale-[0.98]">החלף</button>
              <button onClick={() => onAnalyze(files, mode)} className="flex-1 h-11 rounded-xl text-white font-semibold text-[14px] transition-all active:scale-[0.98]" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)' }}>נתח ({files.length})</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TableImport({ onImport, isAnalyzing, status }) {
  const [step, setStep] = useState('input');
  const [rawText, setRawText] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState({});
  const [shouldEnrich, setShouldEnrich] = useState(true);
  const [parseError, setParseError] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const fileRef = useRef(null);

  const wineFields = [
    { key: 'name', label: 'שם היין', required: true, hints: ['name', 'wine', 'שם', 'יין'] },
    { key: 'producer', label: 'יקב', hints: ['producer', 'winery', 'יקב', 'מפיק'] },
    { key: 'vintage', label: 'שנת בציר', hints: ['vintage', 'year', 'שנה', 'בציר'] },
    { key: 'type', label: 'סוג', hints: ['type', 'color', 'סוג', 'צבע'] },
    { key: 'grape', label: 'זן ענבים', hints: ['grape', 'variety', 'זן', 'ענבים'] },
    { key: 'region', label: 'אזור', hints: ['region', 'country', 'אזור', 'מדינה'] },
    { key: 'quantity', label: 'כמות', hints: ['quantity', 'qty', 'bottles', 'כמות'] },
    { key: 'price', label: 'מחיר', hints: ['price', 'cost', 'מחיר'] },
    { key: 'alcohol', label: 'אחוז אלכוהול', hints: ['alcohol', 'abv', 'אלכוהול'] }
  ];

  const detectDelimiter = (text) => {
    const firstLine = text.split('\n')[0];
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const semicolons = (firstLine.match(/;/g) || []).length;
    if (tabs >= commas && tabs >= semicolons && tabs > 0) return '\t';
    if (semicolons > commas) return ';';
    return ',';
  };

  const parseCSVLine = (line, delimiter) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const parseTable = (text) => {
    const cleaned = text.replace(/^\ufeff/, '').trim();
    if (!cleaned) { setParseError('אין נתונים'); return; }

    const delimiter = detectDelimiter(cleaned);
    const lines = cleaned.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { setParseError('הטבלה חייבת לכלול כותרת ולפחות שורה אחת'); return; }

    const parsedHeaders = parseCSVLine(lines[0], delimiter).map(h => h.replace(/^["']|["']$/g, ''));
    const rows = lines.slice(1).map(line => {
      const cells = parseCSVLine(line, delimiter);
      const obj = {};
      parsedHeaders.forEach((h, i) => { obj[h] = (cells[i] || '').replace(/^["']|["']$/g, ''); });
      return obj;
    }).filter(r => Object.values(r).some(v => v));

    if (rows.length === 0) { setParseError('לא נמצאו שורות תקפות'); return; }

    const autoMap = {};
    wineFields.forEach(field => {
      const matched = parsedHeaders.find(h => {
        const lower = h.toLowerCase();
        return field.hints.some(hint => lower.includes(hint.toLowerCase()));
      });
      if (matched) autoMap[field.key] = matched;
    });

    setHeaders(parsedHeaders);
    setParsedRows(rows);
    setMapping(autoMap);
    setParseError('');
    setStep('mapping');
  };

  const handleFile = async (file) => {
    if (!file) return;
    setIsParsing(true);
    setParseError('');
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      const text = await file.text();
      parseTable(text);
      setIsParsing(false);
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        if (!window.XLSX) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
        }
        const data = await file.arrayBuffer();
        const wb = window.XLSX.read(data);
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const csv = window.XLSX.utils.sheet_to_csv(sheet);
        parseTable(csv);
        setIsParsing(false);
      } catch (e) {
        console.error(e);
        setParseError('שגיאה בקריאת Excel. נסה לשמור כ-CSV.');
        setIsParsing(false);
      }
    } else {
      setParseError('פורמט לא נתמך. השתמש ב-CSV, TSV, או XLSX.');
      setIsParsing(false);
    }
  };

  const normalizeType = (val) => {
    if (!val) return 'red';
    const v = val.toString().toLowerCase().trim();
    if (v.includes('אדום') || v.includes('red')) return 'red';
    if (v.includes('לבן') || v.includes('white')) return 'white';
    if (v.includes('רוזה') || v.includes('rose')) return 'rose';
    if (v.includes('מבעבע') || v.includes('sparkling') || v.includes('champagne')) return 'sparkling';
    if (v.includes('קינוח') || v.includes('dessert')) return 'dessert';
    if (v.includes('מחוזק') || v.includes('fortified') || v.includes('port')) return 'fortified';
    return 'red';
  };

  const buildWines = () => {
    return parsedRows.map(row => {
      const wine = {};
      Object.entries(mapping).forEach(([field, header]) => {
        if (!header) return;
        const val = row[header];
        if (val === undefined || val === '') return;
        if (field === 'vintage') wine.vintage = parseInt(val) || null;
        else if (field === 'quantity') wine.quantity = parseInt(val) || 1;
        else if (field === 'price') wine.price = parseFloat(String(val).replace(/[^\d.]/g, '')) || null;
        else if (field === 'alcohol') wine.alcohol = parseFloat(val) || null;
        else if (field === 'type') wine.type = normalizeType(val);
        else wine[field] = val;
      });
      if (!wine.quantity) wine.quantity = 1;
      if (!wine.type) wine.type = 'red';
      return wine;
    }).filter(w => w.name);
  };

  const validWines = step !== 'input' ? buildWines() : [];

  if (isAnalyzing) {
    return (
      <div className="p-4 rounded-2xl bg-gray-50 border border-black/5 flex items-center gap-3">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#5c1a1b' }} />
        <div>
          <div className="font-semibold text-[14px]" style={{ color: '#1d1d1f' }}>{status}</div>
          <div className="text-[11px] text-gray-500">זה יכול לקחת כמה דקות אם מעשירים במידע</div>
        </div>
      </div>
    );
  }

  if (step === 'input') {
    return (
      <div className="space-y-3">
        <button onClick={() => fileRef.current?.click()} disabled={isParsing} className="w-full py-6 rounded-2xl border-2 border-dashed border-gray-300 hover:border-gray-400 flex flex-col items-center gap-2 transition-all disabled:opacity-50">
          {isParsing ? <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#5c1a1b' }} /> : <Upload className="w-6 h-6" style={{ color: '#5c1a1b' }} strokeWidth={1.8} />}
          <div className="text-center">
            <div className="font-semibold text-[14px]" style={{ color: '#1d1d1f' }}>העלה קובץ</div>
            <div className="text-[11px] text-gray-500">CSV, TSV, XLSX, XLS</div>
          </div>
        </button>
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" className="hidden" onChange={e => handleFile(e.target.files?.[0])} />

        <div className="flex items-center gap-3 text-[12px] text-gray-400">
          <div className="h-px bg-gray-200 flex-1" />
          <span>או</span>
          <div className="h-px bg-gray-200 flex-1" />
        </div>

        <div>
          <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">הדבק טבלה</label>
          <textarea value={rawText} onChange={e => setRawText(e.target.value)} placeholder="הדבק כאן טבלה מאקסל או גוגל שיטס. ודא שהשורה הראשונה היא כותרות" rows={6} className="w-full mt-1 p-3 rounded-xl bg-gray-50 border border-black/5 outline-none focus:border-black/20 text-[13px] font-mono" style={{ direction: 'ltr' }} />
        </div>

        {parseError && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-100 flex items-center gap-2 text-[13px] text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {parseError}
          </div>
        )}

        <button onClick={() => parseTable(rawText)} disabled={!rawText.trim()} className="w-full h-11 rounded-xl text-white font-semibold text-[14px] transition-all active:scale-[0.98] disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)' }}>המשך</button>

        <div className="text-[11px] text-gray-400 leading-relaxed p-3 bg-gray-50 rounded-xl">
          <b>טיפ:</b> המערכת תזהה אוטומטית עמודות בעברית או אנגלית. תוכל להתאים ידנית בשלב הבא.
        </div>
      </div>
    );
  }

  if (step === 'mapping') {
    return (
      <div className="space-y-3">
        <div className="text-[13px] text-gray-600">זוהו <b>{parsedRows.length}</b> שורות עם <b>{headers.length}</b> עמודות. התאם את העמודות:</div>

        <div className="space-y-2 max-h-[320px] overflow-y-auto">
          {wineFields.map(field => (
            <div key={field.key} className="flex items-center gap-2">
              <div className="w-24 shrink-0 text-[13px] font-medium" style={{ color: '#1d1d1f' }}>
                {field.label}
                {field.required && <span className="text-red-500">*</span>}
              </div>
              <select value={mapping[field.key] || ''} onChange={e => setMapping({...mapping, [field.key]: e.target.value})} className="flex-1 h-9 px-2 rounded-lg bg-gray-50 border border-black/5 text-[13px] outline-none">
                <option value="">— דלג —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>

        {!mapping.name && (
          <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-100 text-[12px] text-amber-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            יש למפות לפחות את עמודת "שם היין"
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={() => setStep('input')} className="flex-1 h-11 rounded-xl bg-gray-100 font-medium text-[14px]">חזרה</button>
          <button onClick={() => setStep('preview')} disabled={!mapping.name} className="flex-1 h-11 rounded-xl text-white font-semibold text-[14px] disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)' }}>תצוגה מקדימה</button>
        </div>
      </div>
    );
  }

  if (step === 'preview') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px]">
          <Check className="w-4 h-4 text-green-600" />
          <span><b>{validWines.length}</b> יינות מוכנים לייבוא</span>
        </div>

        <div className="max-h-[280px] overflow-y-auto space-y-1.5 rounded-xl border border-black/5 p-2 bg-gray-50">
          {validWines.slice(0, 30).map((w, i) => (
            <div key={i} className="p-2.5 bg-white rounded-lg text-[12px] flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0">{i+1}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate" style={{ color: '#1d1d1f' }}>{w.name}</div>
                <div className="text-[11px] text-gray-500 truncate">{[w.producer, w.vintage, w.region].filter(Boolean).join(' · ')}</div>
              </div>
              {w.quantity && <div className="text-[11px] text-gray-400 shrink-0">×{w.quantity}</div>}
            </div>
          ))}
          {validWines.length > 30 && <div className="text-center text-[11px] text-gray-400 py-2">ועוד {validWines.length - 30} יינות...</div>}
        </div>

        <label className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-all">
          <input type="checkbox" checked={shouldEnrich} onChange={e => setShouldEnrich(e.target.checked)} className="mt-0.5 w-4 h-4 rounded accent-red-900" />
          <div className="flex-1">
            <div className="text-[13px] font-medium flex items-center gap-1.5" style={{ color: '#1d1d1f' }}>
              <Sparkles className="w-3.5 h-3.5" style={{ color: '#d4a574' }} />
              העשר כל יין עם AI
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">ציונים, חלון שתייה, תווי טעימה ושילובי אוכל. יקח זמן רב יותר.</div>
          </div>
        </label>

        <div className="flex gap-2">
          <button onClick={() => setStep('mapping')} className="flex-1 h-11 rounded-xl bg-gray-100 font-medium text-[14px]">חזרה</button>
          <button onClick={() => onImport(validWines, shouldEnrich)} disabled={!validWines.length} className="flex-[2] h-11 rounded-xl text-white font-semibold text-[14px] disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)', boxShadow: '0 4px 16px rgba(92, 26, 27, 0.3)' }}>ייבא {validWines.length} יינות</button>
        </div>
      </div>
    );
  }

  return null;
}

// Shared component: live wine search that returns detailed suggestions from Claude
function WineSearchResults({ query, callClaude, onSelect, autoSearch, initialResults }) {
  const [results, setResults] = useState(initialResults || []);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const debounceRef = useRef(null);
  const lastQueryRef = useRef('');

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = (query || '').trim();
    if (q.length < 3) {
      setResults([]);
      setSearching(false);
      setSearchError('');
      return;
    }
    const delay = autoSearch ? 100 : 600;
    debounceRef.current = setTimeout(async () => {
      lastQueryRef.current = q;
      setSearching(true);
      setSearchError('');

      const doSearch = async (useWebSearch) => {
        const prompt = useWebSearch
          ? `You are a wine search assistant. The user is searching for: "${q}"

Search Wine-Searcher.com, Vivino, Decanter, and similar wine databases to find up to 8 REAL wines matching this search.

Return ONLY valid JSON (no markdown):
{"results":[{"name":"Full wine name","producer":"Producer","vintage":2019,"type":"red","grape":"Grape variety","region":"Region, Country","appellation":"Appellation","avgPrice":"$25-40","description":"1-sentence description in Hebrew"}]}

CRITICAL:
- type must be VERIFIED: red, white, rose, sparkling, dessert, or fortified
- Only list real wines confirmed by search
- Order by relevance`
          : `You are a wine expert. A user is searching for: "${q}"

Based on your knowledge of wines worldwide (producers, appellations, famous and niche wines), suggest up to 8 wines that best match this query. Match partial names and common misspellings.

Return ONLY valid JSON (no markdown):
{"results":[{"name":"Full wine name","producer":"Producer","vintage":2019,"type":"red","grape":"Grape variety","region":"Region, Country","avgPrice":"$25-40","description":"1-sentence description in Hebrew"}]}

type must be: red, white, rose, sparkling, dessert, or fortified.
Order by relevance and renown.`;

        const result = await callClaude([{ role: 'user', content: prompt }], 1800, useWebSearch ? { useWebSearch: true, maxSearches: 2 } : {});
        let cleaned = result.replace(/```json\n?|```/g, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        if (!cleaned) throw new Error('empty response');
        const parsed = JSON.parse(cleaned);
        return parsed.results || [];
      };

      try {
        // Try web search first
        let found = [];
        try {
          found = await doSearch(true);
        } catch (webErr) {
          console.warn('Web search failed, falling back to knowledge-based search', webErr);
        }

        // If web search returned nothing, try knowledge-based as fallback
        if (!found.length) {
          try {
            found = await doSearch(false);
          } catch (fallbackErr) {
            console.error('Fallback search also failed', fallbackErr);
          }
        }

        if (lastQueryRef.current !== q) return;
        setResults(found);
        if (!found.length) setSearchError('חיפוש הושלם אך לא נמצאו יינות. נסה מונחי חיפוש שונים.');
      } catch (e) {
        console.error('Search error', e);
        if (lastQueryRef.current !== q) return;
        setResults([]);
        setSearchError('שגיאה בחיפוש: ' + (e.message || '').substring(0, 100));
      }
      setSearching(false);
    }, delay);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, autoSearch, callClaude]);

  const getTypeColor = (t) => {
    const map = { red: '#8b2635', white: '#b89d4f', rose: '#d47979', 'rosé': '#d47979', sparkling: '#d4bc6a', dessert: '#a06830', fortified: '#7a4a20' };
    return map[t?.toLowerCase()] || '#8b2635';
  };

  if (searching && results.length === 0) {
    return (
      <div className="py-6 flex items-center justify-center gap-2 text-[13px] text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        מחפש ברחבי האינטרנט...
      </div>
    );
  }

  if (!searching && results.length === 0 && (query || '').trim().length >= 3) {
    return (
      <div className="p-4 text-center text-[13px] text-gray-500">
        {searchError || 'לא נמצאו תוצאות'}
      </div>
    );
  }

  if (results.length === 0) return null;

  return (
    <div className="space-y-1.5 max-h-[320px] overflow-y-auto -mx-1 px-1">
      {results.map((s, i) => (
        <button
          key={i}
          onClick={() => onSelect(s)}
          className="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 active:scale-[0.99] transition-all flex items-start gap-3"
        >
          <div className="w-9 h-12 rounded-md shrink-0 flex items-center justify-center" style={{
            background: `linear-gradient(180deg, ${getTypeColor(s.type)}, rgba(0,0,0,0.6))`
          }}>
            <Wine className="w-4 h-4 text-white/80" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[14px] leading-tight mb-0.5" style={{ color: '#1d1d1f' }}>
              {s.name}
              {s.vintage && <span className="text-gray-500 font-normal"> · {s.vintage}</span>}
            </div>
            <div className="text-[12px] text-gray-500 line-clamp-1">
              {[s.producer, s.region].filter(Boolean).join(' · ')}
            </div>
            {(s.grape || s.avgPrice) && (
              <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                {s.grape && <span>{s.grape}</span>}
                {s.grape && s.avgPrice && <span>·</span>}
                {s.avgPrice && <span>{s.avgPrice}</span>}
              </div>
            )}
          </div>
          <span className="text-gray-300 text-lg shrink-0">‹</span>
        </button>
      ))}
    </div>
  );
}

// Modal shown when a bottle image couldn't be identified - helps user search with the photo visible
function UnrecognizedHelper({ image, onConfirm, onCancel, callClaude }) {
  const [query, setQuery] = useState(image?.partialText || '');
  const [autoSearched, setAutoSearched] = useState(false);

  useEffect(() => {
    // Auto-search on mount if we have partial text
    if (image?.partialText && image.partialText.trim().length >= 3) {
      setAutoSearched(true);
    }
  }, [image]);

  const handleSelect = (suggestion) => {
    onConfirm({
      name: suggestion.name,
      producer: suggestion.producer,
      vintage: suggestion.vintage || null,
      type: suggestion.type || 'red',
      grape: suggestion.grape,
      region: suggestion.region,
      quantity: 1
    }, image.dataUrl);
  };

  return (
    <div className="space-y-3">
      {image?.dataUrl && (
        <div className="relative rounded-xl overflow-hidden bg-gray-100" style={{ maxHeight: '200px' }}>
          <img src={image.dataUrl} alt="Bottle" className="w-full object-contain" style={{ maxHeight: '200px' }} />
        </div>
      )}

      <div className="p-3 rounded-xl bg-amber-50 border border-amber-100">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-amber-900 mb-0.5">לא הצלחתי לזהות את היין בוודאות</div>
            <div className="text-[12px] text-amber-800 leading-relaxed">
              {image?.partialText 
                ? 'הצלחתי לקרוא חלק מהתווית. עזור לי למצוא את היין הנכון בחיפוש למטה.'
                : 'התווית לא קריאה מספיק. חפש ידנית לפי שם היין או היקב.'}
            </div>
          </div>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" strokeWidth={2} />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="הקלד שם יין או יקב..."
          autoFocus
          className="w-full h-11 pr-11 pl-4 rounded-2xl bg-gray-50 border border-black/5 text-[15px] outline-none focus:border-black/20 focus:bg-white transition-all"
        />
      </div>

      <WineSearchResults query={query} callClaude={callClaude} onSelect={handleSelect} autoSearch={autoSearched} />

      <button
        onClick={onCancel}
        className="w-full h-11 rounded-xl bg-gray-100 font-medium text-[14px] transition-all active:scale-[0.98]"
      >
        ביטול
      </button>
    </div>
  );
}

// Modal for "this is not the right wine" flow - helps user pick a replacement
function ReidentifyHelper({ wine, onReplace, onCancel, callClaude }) {
  const [query, setQuery] = useState(wine.name || '');

  const handleSelect = (suggestion) => {
    onReplace({
      name: suggestion.name,
      producer: suggestion.producer,
      vintage: suggestion.vintage || wine.vintage,
      type: suggestion.type || wine.type || 'red',
      grape: suggestion.grape,
      region: suggestion.region,
      quantity: wine.quantity || 1,
      price: wine.price,
      currency: wine.currency
    });
  };

  return (
    <div className="space-y-3">
      {wine.labelImage && (
        <div className="relative rounded-xl overflow-hidden bg-gray-100" style={{ maxHeight: '160px' }}>
          <img src={wine.labelImage} alt="" className="w-full object-contain" style={{ maxHeight: '160px' }} />
        </div>
      )}

      <div className="p-3 rounded-xl bg-blue-50 border border-blue-100 text-[12px] text-blue-900 leading-relaxed">
        חפש את היין הנכון. הכמות והמחיר יישמרו.
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" strokeWidth={2} />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="הקלד שם יין או יקב..."
          autoFocus
          className="w-full h-11 pr-11 pl-4 rounded-2xl bg-gray-50 border border-black/5 text-[15px] outline-none focus:border-black/20 focus:bg-white transition-all"
        />
      </div>

      <WineSearchResults query={query} callClaude={callClaude} onSelect={handleSelect} autoSearch={true} />

      <button
        onClick={onCancel}
        className="w-full h-11 rounded-xl bg-gray-100 font-medium text-[14px] transition-all active:scale-[0.98]"
      >
        ביטול
      </button>
    </div>
  );
}

// Modal for "find more info" — lets user provide hints to refine the enrichment search
function ReenrichHelper({ wine, onReenrich, onCancel }) {
  const [hints, setHints] = useState('');

  const presets = [
    { label: '🔴 זה יין אדום', value: 'This is a RED wine.' },
    { label: '⚪️ זה יין לבן', value: 'This is a WHITE wine.' },
    { label: '🟠 זה יין כתום/טבעי', value: 'This is an ORANGE / natural wine, made with extended skin contact.' },
    { label: '🌸 זה יין רוזה', value: 'This is a ROSE wine.' },
    { label: '🫧 זה יין מבעבע', value: 'This is a SPARKLING wine.' },
  ];

  const togglePreset = (value) => {
    if (hints.includes(value)) {
      setHints(hints.replace(value, '').replace(/\n+/g, '\n').trim());
    } else {
      setHints((hints + '\n' + value).trim());
    }
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-xl bg-blue-50 border border-blue-100 text-[12px] text-blue-900 leading-relaxed">
        אם המידע על היין לא מדויק או חסר, תוכל להוסיף רמזים שיעזרו לחיפוש להיות מדויק יותר. אפשר גם להשאיר ריק וסתם לנסות שוב.
      </div>

      <div className="p-3 rounded-xl bg-gray-50 border border-black/5">
        <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1">היין הנוכחי</div>
        <div className="text-[14px] font-semibold" style={{ color: '#1d1d1f' }}>{wine.name}</div>
        <div className="text-[12px] text-gray-500">{[wine.producer, wine.vintage, wine.region].filter(Boolean).join(' · ')}</div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide block mb-2">סוג מהיר</label>
        <div className="flex flex-wrap gap-1.5">
          {presets.map(p => {
            const active = hints.includes(p.value);
            return (
              <button
                key={p.label}
                onClick={() => togglePreset(p.value)}
                className={"px-3 py-1.5 rounded-full text-[12px] font-medium transition-all " + (active ? 'text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}
                style={active ? { background: '#5c1a1b' } : {}}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">רמזים נוספים (אופציונלי)</label>
        <textarea
          value={hints}
          onChange={e => setHints(e.target.value)}
          placeholder="למשל: זן Sangiovese, מאזור Romagna, יין טבעי, או שם מלא יותר של הקובי..."
          rows={4}
          className="w-full mt-1 p-3 rounded-xl bg-gray-50 border border-black/5 outline-none focus:border-black/20 text-[14px]"
        />
      </div>

      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 h-11 rounded-xl bg-gray-100 font-medium text-[14px]">ביטול</button>
        <button onClick={() => onReenrich(hints)} className="flex-[2] h-11 rounded-xl text-white font-semibold text-[14px]" style={{ background: 'linear-gradient(135deg, #5c1a1b, #3a1011)', boxShadow: '0 4px 16px rgba(92, 26, 27, 0.3)' }}>
          חפש עכשיו
        </button>
      </div>
    </div>
  );
}
