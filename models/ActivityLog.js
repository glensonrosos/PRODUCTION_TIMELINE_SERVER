const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  seasonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Season',
    required: true,
    index: true,
  },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
  },
  taskName: {
    type: String,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  action: {
    type: String,
    required: true,
    enum: ['CREATE_TASK', 'UPDATE_TASK', 'DELETE_TASK', 'UPDATE_REMARKS', 'UPDATE_COMPLETION_DATE', 'UPLOAD_ATTACHMENT', 'DELETE_ATTACHMENT', 'UPDATE_STATUS'],
  },
  details: {
    type: String,
    required: false,
  },
  attachmentId: {
    type: mongoose.Schema.Types.ObjectId,
  },
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
