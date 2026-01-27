const mongoose = require('mongoose');

const SpecificCompetenceSchema = new mongoose.Schema({
  description: { type: String, required: true },
  learningActivities: { type: [String], default: [] },
  expectedStandards: { type: [String], default: [] }
});

const SubtopicSchema = new mongoose.Schema({
  name: { type: String, required: true },
  
  // --- CBC FIELDS ---
  specificCompetences: { type: [SpecificCompetenceSchema], default: [] },
  
  // --- OBC FIELDS ---
  specificOutcomes: { type: [String], default: [] },  // "Specific Outcomes"
  knowledge: { type: [String], default: [] },         // Content -> Knowledge
  skills: { type: [String], default: [] },            // Content -> Skills
  values: { type: [String], default: [] }             // Content -> Values
});

const TopicSchema = new mongoose.Schema({
  name: { type: String, required: true },
  subtopics: [SubtopicSchema]
});

const SyllabusSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  curriculumType: { 
    type: String, 
    required: true, 
    enum: ['cbc', 'obc'] 
  },
  
  // ✨ NEW: Education category (Early Childhood, Primary, Secondary)
  // Note: Only used for CBC. OBC doesn't have categories.
  category: { 
    type: String, 
    required: false,
    // No enum restriction - allows null for OBC syllabi
    validate: {
      validator: function(v) {
        // If value exists, must be one of the valid categories
        if (!v) return true; // null/undefined is allowed
        return ['early-childhood', 'primary', 'secondary'].includes(v);
      },
      message: 'Category must be early-childhood, primary, or secondary (if provided)'
    }
  },
  
  // ✨ NEW: Flexible fields for different education levels
  yearRange: { 
    type: String, 
    required: false  // For Early Childhood (e.g., "3-4", "3-4 years", "Ages 3-4")
  },
  
  grade: { 
    type: String, 
    required: false  // For Primary (e.g., "1", "2", "3", "4", "5", "6") and OBC (e.g., "10", "11", "12")
  },
  
  form: { 
    type: String, 
    required: false  // For Secondary (e.g., "1", "2", "3", "4")
  },
  
  // DEPRECATED: Keep for backward compatibility with old data
  gradeRange: { 
    type: String, 
    required: false  // Old field - no longer used for new uploads
  },
  
  topics: [TopicSchema]
}, { 
  timestamps: true // ✅ AUTOMATICALLY manages createdAt and updatedAt
});

// ✅ CORRECT EXPORT
module.exports = mongoose.model('Syllabus', SyllabusSchema);
