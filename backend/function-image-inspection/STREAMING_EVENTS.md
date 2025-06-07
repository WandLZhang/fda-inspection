# FDA Image Inspection Streaming Events Documentation

This document describes all the streaming events that are sent from the backend to the frontend during the image inspection process. These events provide real-time feedback about the analysis progress.

## Event Structure

Each event follows this JSON structure:
```json
{
  "type": "EVENT_TYPE",
  "content": "Human-readable message (optional)",
  "data": { ... } // Optional data payload
}
```

## Event Types

### 1. ANALYSIS_STARTED
**When:** At the very beginning when a new image processing request is received  
**Content:** "Image inspection process initiated."  
**Data:** 
```json
{
  "inspection_type": "food-safety | pharmaceutical | etc"
}
```

### 2. INITIAL_ANALYSIS_START
**When:** Start of initial AI analysis  
**Content:** "Initializing image analysis with AI..."  
**Data:** None

### 3. INITIAL_ANALYSIS_PROCESSING
**When:** AI model begins processing the image  
**Content:** "AI is processing visual elements and identifying potential violations..."  
**Data:** None

### 4. INITIAL_CITATIONS_IDENTIFIED
**When:** Initial AI analysis completes and citations are parsed  
**Content:** "Initial potential violations identified."  
**Data:** 
```json
{
  "citations": [
    {
      "section": "110.20(b)(4)",
      "text": "All persons...",
      "reason": "The image shows...",
      "box_2d": [y1, x1, y2, x2]
    }
  ]
}
```

### 5. VERIFICATION_PROCESS_START
**When:** Beginning verification phase  
**Content:** "Starting verification and cross-referencing of identified violations with FDA regulations."  
**Data:** 
```json
{
  "citation_count": 3
}
```

### 6. CITATION_VERIFICATION_START
**When:** Starting to verify each individual citation  
**Content:** "Verifying violation 1 of 3..."  
**Data:** 
```json
{
  "citation_index": 0,
  "total_citations": 3
}
```

### 7. CITATION_CODE_LOOKUP
**When:** Retrieving relevant FDA codes for a citation  
**Content:** "Retrieving relevant FDA regulations for violation 1..."  
**Data:** 
```json
{
  "citation_index": 0
}
```

### 8. CITATION_AI_VERIFICATION
**When:** AI is cross-referencing the citation  
**Content:** "Cross-referencing violation 1 with AI and FDA data..."  
**Data:** 
```json
{
  "citation_index": 0
}
```

### 9. SINGLE_CITATION_PROCESSED
**When:** A citation has been fully verified and image generated  
**Content:** "Violation 1 processed and image generated."  
**Data:** 
```json
{
  "citation_index": 0,
  "processed_citation": {
    "section": "110.20(b)(4)",
    "text": "Verified text...",
    "reason": "The image shows...",
    "url": "https://www.ecfr.gov/...",
    "image": "data:image/jpeg;base64,..."
  }
}
```

### 10. SUMMARY_GENERATION_START
**When:** All citations processed, starting summary  
**Content:** "All violations processed. Generating final inspection summary..."  
**Data:** None

### 11. SUMMARY_GENERATED
**When:** Summary text has been generated  
**Content:** "Inspection summary generated."  
**Data:** 
```json
{
  "summary": "The inspection identified several critical violations..."
}
```

### 12. ANALYSIS_FINALIZING
**When:** Final cleanup before completion  
**Content:** "Finalizing analysis..."  
**Data:** None

### 13. ANALYSIS_COMPLETE
**When:** Entire process is complete  
**Content:** "Image inspection complete."  
**Data:** 
```json
{
  "citations": [...],  // Full array of verified citations with images
  "summary": "..."     // Final summary text
}
```

## Frontend Implementation Example

```javascript
const eventSource = new EventSource(`${API_URL}/stream`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch(data.type) {
    case 'ANALYSIS_STARTED':
      showStatus('Starting inspection...');
      break;
      
    case 'INITIAL_CITATIONS_IDENTIFIED':
      showPreliminaryCitations(data.data.citations);
      break;
      
    case 'SINGLE_CITATION_PROCESSED':
      updateCitation(data.data.citation_index, data.data.processed_citation);
      break;
      
    case 'SUMMARY_GENERATED':
      showSummary(data.data.summary);
      break;
      
    case 'ANALYSIS_COMPLETE':
      showFinalResults(data.data);
      eventSource.close();
      break;
  }
};
```

## Benefits

1. **Real-time Feedback**: Users see progress as analysis happens
2. **Early Results**: Initial citations shown before verification
3. **Progressive Updates**: Each citation updates as it's processed
4. **Rich Data**: Frontend receives actionable data, not just status messages
5. **Better UX**: Users understand what's happening at each stage
