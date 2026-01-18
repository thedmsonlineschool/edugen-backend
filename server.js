function parseZambianSyllabus(rawText, curriculum, subject) {

  /* --------------------------------
     1. HARD NORMALISATION
  -------------------------------- */
  let text = rawText
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[•]/g, '•');

  // Force new lines before syllabus numbers
  text = text.replace(/((10|11|12)\.\d+(\.\d+){0,2})/g, '\n$1');

  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const topics = [];

  let currentTopic = null;
  let currentSubtopic = null;
  let currentOutcome = null;
  let pendingNumber = null;

  const numberOnly = line =>
    /^((10|11|12)(\.\d+){1,3})$/.test(line);

  const extract = line => {
    const m = line.match(/^((10|11|12)(\.\d+){1,3})\s*(.*)$/);
    return m ? { number: m[1], text: m[4]?.trim() || '' } : null;
  };

  /* --------------------------------
     2. MAIN PARSE LOOP
  -------------------------------- */
  for (const line of lines) {

    // Skip table headers ONLY
    if (/^topic$|^sub\s*topic$|^specific outcomes?$|^content$/i.test(line)) {
      continue;
    }

    // Handle split numbers
    if (numberOnly(line)) {
      pendingNumber = line;
      continue;
    }

    let parsed = extract(line);

    if (!parsed && pendingNumber) {
      parsed = { number: pendingNumber, text: line };
      pendingNumber = null;
    }

    if (!parsed) continue;

    const level = parsed.number.split('.').length;
    const fullText = `${parsed.number} ${parsed.text}`.trim();

    // TOPIC
    if (level === 2) {
      currentTopic = {
        number: parsed.number,
        name: fullText,
        subtopics: []
      };
      topics.push(currentTopic);
      currentSubtopic = null;
      currentOutcome = null;
      continue;
    }

    // SUBTOPIC
    if (level === 3 && currentTopic &&
        parsed.number.startsWith(currentTopic.number)) {

      currentSubtopic = {
        number: parsed.number,
        name: fullText,
        specificOutcomes: [],
        knowledge: [],
        skills: [],
        values: []
      };

      currentTopic.subtopics.push(currentSubtopic);
      currentOutcome = null;
      continue;
    }

    // OUTCOME
    if (level === 4 && currentSubtopic &&
        parsed.number.startsWith(currentSubtopic.number)) {

      currentOutcome = {
        number: parsed.number,
        text: fullText,
        content: []
      };

      currentSubtopic.specificOutcomes.push(currentOutcome);
      continue;
    }

    // CONTENT
    if (currentOutcome && (line.startsWith('•') || line.startsWith('-'))) {
      const content = line.replace(/^[-•]\s*/, '').trim();
      if (content.length > 3) {
        currentOutcome.content.push(content);
      }
    }
  }

  /* --------------------------------
     3. SAFE RETURN
  -------------------------------- */
  if (!topics.length) {
    console.error('❌ Parsing failed: No topics detected');
    return null;
  }

  return {
    subject,
    curriculumType: curriculum,
    topics
  };
}
