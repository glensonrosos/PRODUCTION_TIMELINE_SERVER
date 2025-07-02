const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  season: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Season',
    required: true
  },
  orderSequence: {
    type: String, // Excel-like: A, B, C... AA, AB
    required: true,
    trim: true
  },
  taskName: {
    type: String,
    required: true,
    trim: true
  },
  responsibleDepartments: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  }],
  precedingTasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task' // Self-referential for dependencies
  }],
  computedDates: {
    start: { type: Date, default: null },
    end: { type: Date, default: null }
  },
  leadTime: {
    type: Number, // in days
    required: true,
    min: [0, 'Lead time cannot be negative']
  },
  actualCompletion: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Completed', 'Blocked', 'Cannot Continue'],
    default: 'Pending'
  },
  remarks: {
    type: String,
    trim: true
  },
  attachments: [{
    fileName: String,
    filePath: String, // Path to the stored file
    fileType: String, // e.g., 'application/pdf', 'image/jpeg'
    uploadedAt: { type: Date, default: Date.now }
  }],
  // For tagging a previous task if this task is blocked
  blockedByTaggingTask: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  }
}, { timestamps: true });

// Ensure unique task orderSequence within a season
TaskSchema.index({ season: 1, orderSequence: 1 }, { unique: true });

module.exports = mongoose.model('Task', TaskSchema);
