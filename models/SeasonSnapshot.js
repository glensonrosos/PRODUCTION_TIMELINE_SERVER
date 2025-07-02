const mongoose = require('mongoose');

const taskSnapshotSchema = new mongoose.Schema({
  order: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  responsible: [{
    type: String,
    // Enum from TaskTemplate's defaultResponsible can be validated at application level
    // if needed, or ensure consistency during snapshot creation.
  }],
  precedingTasks: [{
    type: String // References other 'order' codes within this snapshot's tasks
  }],
  leadTime: {
    type: Number,
    required: true,
    min: 1
  },
  actualCompletion: {
    type: Date,
    required: false
  },
  remarks: {
    type: String,
    trim: true,
    required: false
  },
  attachments: [{
    filename: String,
    path: String, // Store path to the file, actual storage handled by multer/S3 etc.
    mimetype: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  sourceTemplateActiveOnCreation: {
    type: Boolean,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'blocked'],
    default: 'pending'
  },
  computedDates: {
    start: { type: Date, required: false }, // Will be calculated
    end: { type: Date, required: false }    // Will be calculated
  }
});

const seasonSnapshotSchema = new mongoose.Schema({
  seasonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Season',
    required: true // Important for performance: querying snapshots by season
  },
  tasks: [taskSnapshotSchema],
  version: {
    type: Number,
    default: 1 // For tracking changes if task templates are updated mid-season (complex scenario)
  },
  // Potentially add a direct reference to the buyer for easier querying/reporting
  // buyer: {
  //   type: mongoose.Schema.Types.ObjectId,
  //   ref: 'Buyer',
  //   required: true // Denormalized from Season for performance
  // },
  createdAt: {
    type: Date,
    default: Date.now
  }
  // updatedBy, updatedAt can be added if needed for audit trails on the snapshot itself
}, { timestamps: true }); // Adds createdAt and updatedAt to the snapshot document

// Ensure a season can only have one active snapshot of a particular version, or just one active snapshot
// This depends on how versioning is intended to be used. For simplicity, one snapshot per seasonId is common.
// seasonSnapshotSchema.index({ seasonId: 1, version: 1 }, { unique: true });
seasonSnapshotSchema.index({ seasonId: 1 }, { unique: true }); // Simpler: one snapshot per season

const SeasonSnapshot = mongoose.model('SeasonSnapshot', seasonSnapshotSchema);

module.exports = SeasonSnapshot;
