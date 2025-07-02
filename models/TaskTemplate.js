const mongoose = require('mongoose');

const taskTemplateSchema = new mongoose.Schema({
  order: {
    type: String,
    required: true,
    // Regex to ensure one or more uppercase letters (A, B, AA, AB, etc.)
    match: /^[A-Z]+$/,
    unique: true // Assuming order should be unique for templates
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  defaultResponsible: [{
    type: String,
    required: true,
    enum: ["PD", "P&S", "AM", "QA", "Logistics", "Production", "IT"]
  }],
  defaultPrecedingTasks: [{
    type: String // References other 'order' codes from TaskTemplate
    // We'll need application-level validation for existence and circular dependencies
  }],
  defaultLeadTime: { type: Number, min: 1, required: [true, 'Default lead time is required'] },
  isActive: { type: Boolean, required: true, default: true }
}, { timestamps: true });


const TaskTemplate = mongoose.model('TaskTemplate', taskTemplateSchema);

module.exports = TaskTemplate;
