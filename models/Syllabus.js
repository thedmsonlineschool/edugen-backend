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
  form: { type: String, required: true }, // e.g., "Form 1" or "Grade 10"
  topics: [TopicSchema]
}, { 
  timestamps: true // ✅ AUTOMATICALLY manages createdAt and updatedAt
});

module.exports = mongoose.model('Syllabus', SyllabusSchema);
